// Cloudflare Worker: the only place that holds the Gemini API key. The extension never
// sees it. Two routes: POST /profile (resume text -> candidate profile) and POST /verdict
// (candidate profile + preferences + JD text -> APPLY/SKIP decision). Both are a single
// Gemini call each — no multi-agent chaining, to keep latency and token cost low.
import { DETECT_SYSTEM_PROMPT_FULL, VERDICT_SYSTEM_PROMPT_FULL, PROFILE_SYSTEM_PROMPT } from "./prompts.js";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS },
  });
}

/** Simple per-IP daily counter in Workers KV — the rate-limit valve since there's no signup. */
async function checkRateLimit(env, ip, bucket, limit) {
  const day = new Date().toISOString().slice(0, 10);
  const key = `${bucket}:${ip}:${day}`;
  const current = parseInt((await env.RATE_LIMIT.get(key)) || "0", 10);
  if (current >= limit) return false;
  await env.RATE_LIMIT.put(key, String(current + 1), { expirationTtl: 60 * 60 * 26 });
  return true;
}

/** Extracts a JSON object from text that may have stray preamble/trailing text around it. */
function extractJSON(text) {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) throw new Error("No JSON object found in model output");
  return JSON.parse(text.slice(start, end + 1));
}

const TRANSIENT_STATUSES = new Set([429, 500, 502, 503, 504]);

async function callGeminiOnce(env, systemPrompt, userContent, maxOutputTokens) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${env.GEMINI_MODEL}:generateContent?key=${env.GEMINI_API_KEY}`;
  const body = {
    // systemInstruction is Gemini's dedicated channel for the system prompt — keeping it
    // out of the user turn's `contents` is what actually suppresses conversational preamble
    // ("Here is the JSON:") reliably; concatenating it into the user message (the previous
    // approach) let the model treat the whole thing as one blob and occasionally add filler.
    systemInstruction: { parts: [{ text: systemPrompt }] },
    contents: [{ role: "user", parts: [{ text: userContent }] }],
    // thinkingBudget: 0 disables Gemini 2.5's internal "thinking" pass, which otherwise
    // consumes output tokens (and wall-clock time) BEFORE the model even starts writing
    // the actual JSON — with a small maxOutputTokens cap, thinking alone can eat the whole
    // budget and truncate the real response. Disabling it is the single biggest lever on
    // latency for this task (a screening judgment doesn't need visible chain-of-thought).
    generationConfig: {
      responseMimeType: "application/json",
      temperature: 0.2,
      maxOutputTokens,
      thinkingConfig: { thinkingBudget: 0 },
    },
  };
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    const err = new Error(`Gemini API error ${res.status}: ${errText.slice(0, 300)}`);
    err.status = res.status;
    throw err;
  }
  const data = await res.json();
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error("Gemini returned no content");
  // Resilient parse: JSON mode + systemInstruction should always yield clean JSON, but if a
  // stray preamble/trailing sentence ever slips through, extract the embedded object rather
  // than hard-failing the whole request.
  try {
    return JSON.parse(text);
  } catch {
    return extractJSON(text);
  }
}

/** One retry, short backoff, only on transient failures (network throw or 429/5xx) — a
 *  deterministic client error (400/401/403) is retried never, since retrying just burns time
 *  and rate-limit budget on a request that will fail identically again. */
async function callGemini(env, systemPrompt, userContent, maxOutputTokens) {
  try {
    return await callGeminiOnce(env, systemPrompt, userContent, maxOutputTokens);
  } catch (err) {
    const isTransient = err.status === undefined || TRANSIENT_STATUSES.has(err.status);
    if (!isTransient) throw err;
    console.error("Gemini call failed, retrying once:", err.message || err);
    await new Promise((r) => setTimeout(r, 500));
    return callGeminiOnce(env, systemPrompt, userContent, maxOutputTokens);
  }
}

/** Maps a caught error to a clean, actionable client message. A 429 that survives the retry in
 *  callGemini means Gemini's OWN shared quota/rate limit (the one API key every free-tier user
 *  shares) is exhausted right now — that is a distinct, common, and fixable situation, so it gets
 *  its own specific message pointing at the BYOK escape hatch, instead of being lumped in with
 *  genuine outages (5xx) under a vague "temporarily unavailable." */
function upstreamErrorMessage(err) {
  if (err.status === 429) {
    return {
      message: "The free shared AI service has hit its usage limit for the moment. Add your own free API key in Settings (Gemini, OpenAI, Anthropic, Groq, or OpenRouter all work) to keep going without waiting.",
      status: 503,
    };
  }
  return { message: "The AI service is temporarily unavailable. Please try again in a moment.", status: 502 };
}

// Stage 1 (detection) sees ONLY the page title + text — never the candidate profile — so the
// model cannot use topical overlap with the candidate's own skills/projects as (false) evidence
// that a page is a job posting.
function buildDetectUserContent(title, jdText) {
  return `Input: ${JSON.stringify({ title: title || "", text: jdText })}\nOutput:`;
}

// Stage 2 (fit) — few-shot examples live in the static system prompt (VERDICT_SYSTEM_PROMPT_FULL),
// so the per-call user content is just the real case, ordered static-ish fields (title, profile)
// before the varying JD text.
function buildVerdictUserContent(profile, preferences, title, jdText) {
  return `Input: ${JSON.stringify({ title: title || "", profile, preferences, jd: jdText })}\nOutput:`;
}

function truncate(text, maxChars) {
  return text.length > maxChars ? text.slice(0, maxChars) : text;
}

async function handleVerdict(req, env, ip) {
  if (!(await checkRateLimit(env, ip, "verdict", parseInt(env.DAILY_VERDICT_LIMIT, 10)))) {
    return json({ error: "Daily limit reached. Try again tomorrow, or add your own API key in settings." }, 429);
  }
  const { profile, preferences, title, jdText } = await req.json();
  if (!profile || !jdText) return json({ error: "Missing profile or jdText" }, 400);

  // Cap input size defensively — keeps token cost bounded even if scraper trimming misses something.
  const trimmedJD = truncate(jdText, 6000);

  try {
    // Stage 1 — profile-blind job-posting detection. If this isn't a posting, we return NO_JD
    // and never run the fit call (cheaper on non-job pages, and structurally immune to the
    // resume biasing detection).
    const detect = await callGemini(env, DETECT_SYSTEM_PROMPT_FULL, buildDetectUserContent(title, trimmedJD), 20);
    if (detect?.isJobPosting !== true) {
      return json({ decision: "NO_JD", confidence: "high", reason: "", gaps: [], model: env.GEMINI_MODEL });
    }

    // Stage 2 — APPLY/SKIP fit. Small cap: the leaner {decision, confidence, reason, gaps} schema
    // needs little room.
    const userContent = buildVerdictUserContent(profile, preferences || {}, title, trimmedJD);
    const verdict = await callGemini(env, VERDICT_SYSTEM_PROMPT_FULL, userContent, 220);
    return json({ ...verdict, model: env.GEMINI_MODEL });
  } catch (err) {
    // Never leak raw upstream error text (status codes, provider internals) to the client —
    // log the real detail server-side (visible via `wrangler tail`) and return sanitized,
    // actionable copy instead (see upstreamErrorMessage).
    console.error("handleVerdict failed:", err.message || err);
    const { message, status } = upstreamErrorMessage(err);
    return json({ error: message }, status);
  }
}

async function handleProfile(req, env, ip) {
  if (!(await checkRateLimit(env, ip, "profile", parseInt(env.DAILY_PROFILE_LIMIT, 10)))) {
    return json({ error: "Daily limit reached. Try again tomorrow, or add your own API key in settings." }, 429);
  }
  const { resumeText } = await req.json();
  if (!resumeText || resumeText.trim().length < 40) return json({ error: "Missing or too-short resumeText" }, 400);

  const trimmed = truncate(resumeText, 8000);
  try {
    // Larger cap than the verdict: skills/notableProjects arrays need more room, but this
    // still bounds worst-case generation time for very long resumes.
    const profile = await callGemini(env, PROFILE_SYSTEM_PROMPT, trimmed, 500);
    return json(profile);
  } catch (err) {
    console.error("handleProfile failed:", err.message || err);
    const { message, status } = upstreamErrorMessage(err);
    return json({ error: message }, status);
  }
}

export default {
  async fetch(req, env) {
    if (req.method === "OPTIONS") return new Response(null, { headers: CORS_HEADERS });
    if (req.method !== "POST") return json({ error: "POST only" }, 405);

    const ip = req.headers.get("CF-Connecting-IP") || "unknown";
    const url = new URL(req.url);

    try {
      if (url.pathname === "/verdict") return await handleVerdict(req, env, ip);
      if (url.pathname === "/profile") return await handleProfile(req, env, ip);
      return json({ error: "Not found" }, 404);
    } catch (err) {
      return json({ error: String(err.message || err) }, 500);
    }
  },
};

// Cloudflare Worker: the only place that holds the Gemini API key. The extension never
// sees it. Two routes: POST /profile (resume text -> candidate profile) and POST /verdict
// (candidate profile + preferences + JD text -> APPLY/SKIP decision). Both are a single
// Gemini call each — no multi-agent chaining, to keep latency and token cost low.
import { VERDICT_SYSTEM_PROMPT, VERDICT_FEW_SHOT, PROFILE_SYSTEM_PROMPT } from "./prompts.js";

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

async function callGemini(env, systemPrompt, userContent) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${env.GEMINI_MODEL}:generateContent?key=${env.GEMINI_API_KEY}`;
  const body = {
    contents: [{ role: "user", parts: [{ text: `${systemPrompt}\n\n${userContent}` }] }],
    generationConfig: { responseMimeType: "application/json", temperature: 0.3 },
  };
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(`Gemini API error ${res.status}: ${errText.slice(0, 300)}`);
  }
  const data = await res.json();
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error("Gemini returned no content");
  return JSON.parse(text);
}

function buildVerdictUserContent(profile, preferences, jdText) {
  const examples = VERDICT_FEW_SHOT.map(
    (ex, i) => `Example ${i + 1}:\nInput: ${JSON.stringify(ex.input)}\nOutput: ${JSON.stringify(ex.output)}`
  ).join("\n\n");
  return `${examples}\n\nNow decide for this real case:\nInput: ${JSON.stringify({ profile, preferences, jd: jdText })}\nOutput:`;
}

function truncate(text, maxChars) {
  return text.length > maxChars ? text.slice(0, maxChars) : text;
}

async function handleVerdict(req, env, ip) {
  if (!(await checkRateLimit(env, ip, "verdict", parseInt(env.DAILY_VERDICT_LIMIT, 10)))) {
    return json({ error: "Daily limit reached. Try again tomorrow, or add your own API key in settings." }, 429);
  }
  const { profile, preferences, jdText } = await req.json();
  if (!profile || !jdText) return json({ error: "Missing profile or jdText" }, 400);

  // Cap input size defensively — keeps token cost bounded even if scraper trimming misses something.
  const trimmedJD = truncate(jdText, 6000);
  const userContent = buildVerdictUserContent(profile, preferences || {}, trimmedJD);

  try {
    const verdict = await callGemini(env, VERDICT_SYSTEM_PROMPT, userContent);
    return json(verdict);
  } catch (err) {
    return json({ error: String(err.message || err) }, 502);
  }
}

async function handleProfile(req, env, ip) {
  if (!(await checkRateLimit(env, ip, "profile", parseInt(env.DAILY_PROFILE_LIMIT, 10)))) {
    return json({ error: "Daily limit reached. Try again tomorrow." }, 429);
  }
  const { resumeText } = await req.json();
  if (!resumeText || resumeText.trim().length < 40) return json({ error: "Missing or too-short resumeText" }, 400);

  const trimmed = truncate(resumeText, 8000);
  try {
    const profile = await callGemini(env, PROFILE_SYSTEM_PROMPT, trimmed);
    return json(profile);
  } catch (err) {
    return json({ error: String(err.message || err) }, 502);
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

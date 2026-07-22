// Thin client for the recruiter-judgment calls. Default path goes through the developer's
// Cloudflare Worker (no signup, shared free tier, rate-limited). If the user has pasted
// their own API key in settings (BYOK), calls go straight to whichever provider the key
// belongs to — auto-detected from the key's format, no dropdown/model picker needed —
// bypassing the Worker and its rate limit entirely.
(function (root) {
  const WORKER_BASE_URL = "https://applyornot-api.ashrafahmed1232.workers.dev";
  const GEMINI_MODEL = "gemini-2.5-flash";
  const REQUEST_TIMEOUT_MS = 30000;
  const TRANSIENT_STATUSES = new Set([429, 500, 502, 503, 504]);

  async function fetchWithTimeout(url, options) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      return await fetch(url, { ...options, signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
  }

  async function getByokKey() {
    const { settings } = await chrome.storage.local.get("settings");
    return settings?.byokApiKey?.trim() || null;
  }

  /** Extracts a JSON object from text that may have stray preamble/trailing text around it. */
  function extractJSON(text) {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start === -1 || end === -1 || end < start) throw new Error("No JSON object found in model output");
    return JSON.parse(text.slice(start, end + 1));
  }

  /** Maps a raw thrown error to clean, user-facing copy — never surface provider internals
   *  (status codes, upstream error bodies) directly in the UI. A 429 here is only ever from the
   *  BYOK direct-call path (the Worker sanitizes its own errors into plain text before the client
   *  ever sees them, with no .status attached) — meaning the user's OWN key hit its provider's
   *  rate limit or quota, which gets a specific, actionable message rather than a vague one. */
  function toFriendlyError(err) {
    if (err?.name === "AbortError") return new Error("The request timed out. Please try again.");
    if (err?.status === 429) {
      return new Error("Your API key has hit its provider's rate limit or usage quota. Wait a moment and try again, or check your account for quota/billing details.");
    }
    const msg = String(err?.message || err || "");
    if (/^(Gemini|OpenAI|Anthropic|Groq|OpenRouter) API error/.test(msg) || /HTTP \d+/.test(msg)) {
      return new Error("The AI service is temporarily unavailable. Please try again in a moment.");
    }
    return err instanceof Error ? err : new Error(msg || "Something went wrong.");
  }

  // ---------- Provider detection (single key field, no dropdown) ----------
  // Each provider issues keys with a recognizable prefix, so the extension can route correctly
  // from one plain-text input with no provider picker or base-URL field.
  function detectProvider(key) {
    if (/^sk-ant-/.test(key)) {
      return { provider: "anthropic", model: "claude-haiku-4-5" };
    }
    if (/^gsk_/.test(key)) {
      return { provider: "openai-compatible", model: "llama-3.3-70b-versatile", baseUrl: "https://api.groq.com/openai/v1", label: "groq" };
    }
    if (/^sk-or-/.test(key)) {
      return { provider: "openai-compatible", model: "openai/gpt-4o-mini", baseUrl: "https://openrouter.ai/api/v1", label: "openrouter" };
    }
    if (/^sk-/.test(key)) {
      return { provider: "openai-compatible", model: "gpt-4o-mini", baseUrl: "https://api.openai.com/v1", label: "openai" };
    }
    if (/^(AIza|AQ\.)/.test(key)) {
      return { provider: "gemini", model: GEMINI_MODEL };
    }
    return null;
  }

  // ---------- Per-provider adapters: (systemPrompt, userContent, key, maxOutputTokens) -> JSON ----------
  async function callGeminiAdapter(systemPrompt, userContent, key, maxOutputTokens, model) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`;
    const res = await fetchWithTimeout(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: systemPrompt }] },
        contents: [{ role: "user", parts: [{ text: userContent }] }],
        generationConfig: {
          responseMimeType: "application/json",
          temperature: 0.2,
          maxOutputTokens,
          thinkingConfig: { thinkingBudget: 0 },
        },
      }),
    });
    if (!res.ok) {
      const err = new Error(`Gemini API error ${res.status}`);
      err.status = res.status;
      throw err;
    }
    const data = await res.json();
    const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) throw new Error("Gemini returned no content");
    try {
      return JSON.parse(text);
    } catch {
      return extractJSON(text);
    }
  }

  /** Shared by OpenAI, Groq, OpenRouter — all speak the same chat/completions shape. */
  async function callOpenAICompatibleAdapter(systemPrompt, userContent, key, maxOutputTokens, model, baseUrl) {
    const res = await fetchWithTimeout(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userContent },
        ],
        response_format: { type: "json_object" },
        temperature: 0.2,
        max_tokens: maxOutputTokens,
      }),
    });
    if (!res.ok) {
      const err = new Error(`OpenAI API error ${res.status}`);
      err.status = res.status;
      throw err;
    }
    const data = await res.json();
    const text = data?.choices?.[0]?.message?.content;
    if (!text) throw new Error("Provider returned no content");
    try {
      return JSON.parse(text);
    } catch {
      return extractJSON(text);
    }
  }

  async function callAnthropicAdapter(systemPrompt, userContent, key, maxOutputTokens, model) {
    const res = await fetchWithTimeout("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": key,
        "anthropic-version": "2023-06-01",
        "anthropic-dangerous-direct-browser-access": "true",
      },
      body: JSON.stringify({
        model,
        // Anthropic has no dedicated JSON-mode flag — the system prompt already instructs
        // "output JSON only", and extractJSON below is the safety net for any stray text.
        system: systemPrompt,
        messages: [{ role: "user", content: userContent }],
        max_tokens: maxOutputTokens,
        temperature: 0.2,
      }),
    });
    if (!res.ok) {
      const err = new Error(`Anthropic API error ${res.status}`);
      err.status = res.status;
      throw err;
    }
    const data = await res.json();
    const text = data?.content?.[0]?.text;
    if (!text) throw new Error("Anthropic returned no content");
    try {
      return JSON.parse(text);
    } catch {
      return extractJSON(text);
    }
  }

  async function dispatchOnce(info, systemPrompt, userContent, key, maxOutputTokens) {
    if (info.provider === "gemini") return callGeminiAdapter(systemPrompt, userContent, key, maxOutputTokens, info.model);
    if (info.provider === "anthropic") return callAnthropicAdapter(systemPrompt, userContent, key, maxOutputTokens, info.model);
    return callOpenAICompatibleAdapter(systemPrompt, userContent, key, maxOutputTokens, info.model, info.baseUrl);
  }

  /** One retry, short backoff, transient failures only (network throw or 429/5xx) — a
   *  deterministic client error (400/401/403) is never retried. */
  async function callDirect(systemPrompt, userContent, apiKey, maxOutputTokens) {
    const info = detectProvider(apiKey);
    if (!info) {
      throw new Error("Unrecognized API key format — paste a Gemini, OpenAI, Anthropic, Groq, or OpenRouter key.");
    }
    try {
      const result = await dispatchOnce(info, systemPrompt, userContent, apiKey, maxOutputTokens);
      return { ...result, model: info.model };
    } catch (err) {
      const isTransient = err.status === undefined || TRANSIENT_STATUSES.has(err.status);
      if (!isTransient) throw err;
      await new Promise((r) => setTimeout(r, 500));
      const result = await dispatchOnce(info, systemPrompt, userContent, apiKey, maxOutputTokens);
      return { ...result, model: info.model };
    }
  }

  async function callWorker(path, body) {
    const url = `${WORKER_BASE_URL}${path}`;
    const res = await fetchWithTimeout(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => null);
    if (!res.ok) {
      throw new Error(data?.error || `Request failed (${res.status})`);
    }
    return data;
  }

  /** JD text is capped defensively — the scraper already trims boilerplate before this. */
  function truncate(text, maxChars) {
    return text.length > maxChars ? text.slice(0, maxChars) : text;
  }

  async function extractProfile(resumeText) {
    const trimmed = truncate(resumeText, 8000);
    const byokKey = await getByokKey();
    try {
      if (byokKey) {
        return await callDirect(PromptsLib.PROFILE_SYSTEM_PROMPT, trimmed, byokKey, 500);
      }
      return await callWorker("/profile", { resumeText: trimmed });
    } catch (err) {
      throw toFriendlyError(err);
    }
  }

  // Stage 1 (detection) sees ONLY page title + text — never the profile — so topical overlap with
  // the candidate's own skills/projects can't be misread as job-posting evidence.
  function buildDetectUserContent(title, jdText) {
    return `Input: ${JSON.stringify({ title: title || "", text: jdText })}\nOutput:`;
  }

  /** Few-shot examples live in PromptsLib.VERDICT_SYSTEM_PROMPT_FULL (static, appended once to
   *  the system prompt) — the per-call user content is only the real case, static-ish fields
   *  (title, profile) ordered before the varying JD text. */
  function buildVerdictUserContent(profile, preferences, title, jdText) {
    return `Input: ${JSON.stringify({ title: title || "", profile, preferences, jd: jdText })}\nOutput:`;
  }

  async function getVerdict(profile, preferences, title, jdText) {
    const trimmedJD = truncate(jdText, 6000);
    const byokKey = await getByokKey();
    try {
      if (byokKey) {
        // Stage 1 — profile-blind job-posting detection. Not a posting → NO_JD, skip Stage 2.
        const detect = await callDirect(PromptsLib.DETECT_SYSTEM_PROMPT_FULL, buildDetectUserContent(title, trimmedJD), byokKey, 20);
        if (detect?.isJobPosting !== true) {
          return { decision: "NO_JD", confidence: "high", reason: "", gaps: [], model: detect?.model };
        }
        // Stage 2 — APPLY/SKIP fit.
        const userContent = buildVerdictUserContent(profile, preferences || {}, title, trimmedJD);
        return await callDirect(PromptsLib.VERDICT_SYSTEM_PROMPT_FULL, userContent, byokKey, 220);
      }
      return await callWorker("/verdict", { profile, preferences, title, jdText: trimmedJD });
    } catch (err) {
      throw toFriendlyError(err);
    }
  }

  const LLMLib = { extractProfile, getVerdict, detectProvider, WORKER_BASE_URL };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = LLMLib;
  } else {
    root.LLMLib = LLMLib;
  }
})(typeof self !== "undefined" ? self : this);

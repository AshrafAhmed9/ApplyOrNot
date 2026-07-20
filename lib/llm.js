// Thin client for the recruiter-judgment calls. Default path goes through the developer's
// Cloudflare Worker (no signup, shared free tier, rate-limited). If the user has pasted
// their own Gemini API key in settings (BYOK), calls go straight to Gemini from the
// extension instead — bypasses the Worker and its rate limit entirely.
(function (root) {
  const WORKER_BASE_URL = "https://applyornot-api.ashrafahmed1232.workers.dev";
  const GEMINI_MODEL = "gemini-2.5-flash";
  const REQUEST_TIMEOUT_MS = 30000;

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

  async function callGeminiDirect(systemPrompt, userContent, apiKey) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${apiKey}`;
    const res = await fetchWithTimeout(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: `${systemPrompt}\n\n${userContent}` }] }],
        generationConfig: { responseMimeType: "application/json", temperature: 0.3 },
      }),
    });
    if (!res.ok) throw new Error(`Gemini API error ${res.status}`);
    const data = await res.json();
    const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) throw new Error("Gemini returned no content");
    return JSON.parse(text);
  }

  async function callWorker(path, body) {
    const url = `${WORKER_BASE_URL}${path}`;
    console.log("[ApplyOrNot] calling", url);
    let res;
    try {
      res = await fetchWithTimeout(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    } catch (err) {
      console.error("[ApplyOrNot] fetch to worker threw", err);
      throw err;
    }
    console.log("[ApplyOrNot] worker responded with status", res.status);
    const data = await res.json().catch((e) => {
      console.error("[ApplyOrNot] failed to parse worker response as JSON", e);
      return null;
    });
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
    if (byokKey) {
      return callGeminiDirect(PromptsLib.PROFILE_SYSTEM_PROMPT, trimmed, byokKey);
    }
    return callWorker("/profile", { resumeText: trimmed });
  }

  async function getVerdict(profile, preferences, jdText) {
    const trimmedJD = truncate(jdText, 6000);
    const byokKey = await getByokKey();
    if (byokKey) {
      const userContent = `Input: ${JSON.stringify({ profile, preferences, jd: trimmedJD })}\nOutput:`;
      return callGeminiDirect(PromptsLib.VERDICT_SYSTEM_PROMPT, userContent, byokKey);
    }
    return callWorker("/verdict", { profile, preferences, jdText: trimmedJD });
  }

  const LLMLib = { extractProfile, getVerdict, WORKER_BASE_URL };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = LLMLib;
  } else {
    root.LLMLib = LLMLib;
  }
})(typeof self !== "undefined" ? self : this);

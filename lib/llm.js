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

  /** Extracts a JSON object from text that may have stray preamble/trailing text around it. */
  function extractJSON(text) {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start === -1 || end === -1 || end < start) throw new Error("No JSON object found in model output");
    return JSON.parse(text.slice(start, end + 1));
  }

  async function callGeminiDirect(systemPrompt, userContent, apiKey, maxOutputTokens) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${apiKey}`;
    const res = await fetchWithTimeout(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        // systemInstruction keeps the system prompt out of the user turn — this is what
        // actually suppresses conversational preamble ("Here is the JSON:") reliably
        // (matches worker/index.js).
        systemInstruction: { parts: [{ text: systemPrompt }] },
        contents: [{ role: "user", parts: [{ text: userContent }] }],
        // thinkingBudget: 0 disables Gemini 2.5's internal "thinking" pass — otherwise it
        // silently consumes the output-token budget and wall-clock time before the model
        // even starts the actual JSON response.
        generationConfig: {
          responseMimeType: "application/json",
          temperature: 0.2,
          maxOutputTokens,
          thinkingConfig: { thinkingBudget: 0 },
        },
      }),
    });
    if (!res.ok) throw new Error(`Gemini API error ${res.status}`);
    const data = await res.json();
    const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) throw new Error("Gemini returned no content");
    try {
      return JSON.parse(text);
    } catch {
      return extractJSON(text);
    }
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
      return callGeminiDirect(PromptsLib.PROFILE_SYSTEM_PROMPT, trimmed, byokKey, 500);
    }
    return callWorker("/profile", { resumeText: trimmed });
  }

  /** Mirrors the Worker's buildVerdictUserContent so BYOK gets the same few-shot calibration. */
  function buildVerdictUserContent(profile, preferences, jdText) {
    const examples = (PromptsLib.VERDICT_FEW_SHOT || [])
      .map((ex, i) => `Example ${i + 1}:\nInput: ${JSON.stringify(ex.input)}\nOutput: ${JSON.stringify(ex.output)}`)
      .join("\n\n");
    return `${examples}\n\nNow decide for this real case:\nInput: ${JSON.stringify({ profile, preferences, jd: jdText })}\nOutput:`;
  }

  async function getVerdict(profile, preferences, jdText) {
    const trimmedJD = truncate(jdText, 6000);
    const byokKey = await getByokKey();
    if (byokKey) {
      const userContent = buildVerdictUserContent(profile, preferences || {}, trimmedJD);
      return callGeminiDirect(PromptsLib.VERDICT_SYSTEM_PROMPT, userContent, byokKey, 220);
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

// Service worker: owns the offscreen document (embedding model host) and
// routes EMBED requests from the popup and content scripts to it.
const OFFSCREEN_URL = "offscreen/offscreen.html";
let creatingOffscreen = null;

async function ensureOffscreen() {
  const existing = await chrome.runtime.getContexts?.({
    contextTypes: ["OFFSCREEN_DOCUMENT"],
    documentUrls: [chrome.runtime.getURL(OFFSCREEN_URL)],
  });
  if (existing && existing.length > 0) return;

  if (creatingOffscreen) {
    await creatingOffscreen;
    return;
  }
  creatingOffscreen = chrome.offscreen.createDocument({
    url: OFFSCREEN_URL,
    reasons: ["WORKERS"],
    justification: "Runs an on-device sentence-embedding model (ONNX/WASM) to compare resume and job description text locally.",
  });
  try {
    await creatingOffscreen;
  } finally {
    creatingOffscreen = null;
  }
}

async function embedTexts(texts) {
  await ensureOffscreen();
  return chrome.runtime.sendMessage({ target: "offscreen", type: "EMBED", texts });
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type !== "EMBED_REQUEST") return false;
  embedTexts(msg.texts)
    .then((res) => sendResponse(res))
    .catch((err) => sendResponse({ ok: false, error: String(err?.message || err) }));
  return true;
});

// Runs inside the extension's offscreen document. Hosts the on-device
// sentence-embedding model (MiniLM, ONNX+WASM) and answers EMBED requests
// from background.js. Nothing here ever touches the network after install.
import { pipeline, env } from "../lib/transformers.min.js";

env.allowRemoteModels = false;
env.allowLocalModels = true;
env.localModelPath = chrome.runtime.getURL("model/");
env.backends.onnx.wasm.wasmPaths = chrome.runtime.getURL("lib/");
env.backends.onnx.wasm.numThreads = 1; // extension pages can't rely on cross-origin isolation

let embedderPromise = null;
function getEmbedder() {
  if (!embedderPromise) {
    embedderPromise = pipeline("feature-extraction", "Xenova/all-MiniLM-L6-v2", {
      quantized: true,
    });
  }
  return embedderPromise;
}

async function embed(texts) {
  const embedder = await getEmbedder();
  const output = await embedder(texts, { pooling: "mean", normalize: true });
  // output.dims = [batch, 384]; convert to plain arrays for structured-clone messaging
  const dim = output.dims[output.dims.length - 1];
  const vectors = [];
  for (let i = 0; i < texts.length; i++) {
    vectors.push(Array.from(output.data.slice(i * dim, (i + 1) * dim)));
  }
  return vectors;
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.target !== "offscreen" || msg?.type !== "EMBED") return false;
  embed(msg.texts)
    .then((vectors) => sendResponse({ ok: true, vectors }))
    .catch((err) => sendResponse({ ok: false, error: String(err?.message || err) }));
  return true; // keep the message channel open for the async response
});

// Runs the resume-profile extraction here (not in the popup) because Chrome tears down
// the popup's JS execution the moment it loses focus — which can happen right after the
// native file-picker dialog closes, aborting any in-flight fetch mid-request ("signal is
// aborted without reason"). The service worker persists independently of the popup, and
// unconditionally saves the result to storage as soon as it's ready — so even if the
// popup that triggered this already closed, the profile is there next time it's opened.
importScripts("lib/prompts.js", "lib/llm.js");

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type !== "EXTRACT_PROFILE") return false;

  LLMLib.extractProfile(msg.resumeText)
    .then(async (profile) => {
      profile.fileName = msg.fileName;
      await chrome.storage.local.set({ profile });
      sendResponse({ ok: true, profile });
    })
    .catch((err) => {
      console.error("[ApplyOrNot bg] extractProfile failed", err);
      sendResponse({ ok: false, error: String(err?.message || err) });
    });

  return true; // keep the message channel open for the async response above
});

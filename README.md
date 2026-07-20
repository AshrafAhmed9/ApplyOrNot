# ApplyOrNot

Instant APPLY / DON'T APPLY verdict for a job listing, based on your resume — experience gate, field match, and skill coverage, all computed on-device (no server, no LLM, no signup).

## Load it locally (macOS Chrome)

1. Open `chrome://extensions`.
2. Toggle **Developer mode** (top-right).
3. Click **Load unpacked** and select this project folder (`Chrome extension/`).
4. The **ApplyOrNot** icon appears in your toolbar.
5. Click it → **Upload Resume** (PDF) → confirm the detected field → adjust skill tags if needed → set your target experience range → **Save resume**.
6. Open a LinkedIn job listing (`linkedin.com/jobs/...`). A verdict overlay should appear automatically in the bottom-right — no button press needed.
7. Click through to other job listings in the same LinkedIn session; the overlay should update itself automatically (no reload, no re-click).

### What to check while testing
- **First load / first scan is slow** (~1-2s) — that's the one-time WASM model load per browser session; it should feel instant on every scan after that.
- Open the page console (F12) and check for errors, especially anything from `offscreen.js`, `background.js`, or `content_script.js`.
- On the extension card in `chrome://extensions`, click **Errors** if the icon shows a warning badge — this surfaces manifest/service-worker load failures.
- To inspect the popup's own console: right-click the toolbar icon → **Inspect popup**.
- To inspect the offscreen document (where the embedding model runs): `chrome://extensions` → the extension's **service worker** link → **Application/Frames**, or check `chrome://inspect/#extensions` if it doesn't show inline.
- After any code change: click the refresh icon on the extension card, then reload the job-listing tab (content-script changes need the page reloaded).

## Regression tests (no browser needed)

```
node test/node_check.js
```
Runs the deterministic experience-gate and structural matcher logic (weighting, thresholds, domain gating) against fixtures. A browser-based mirror of the same suite is at `test/matcher.test.html` (open directly in any browser).

These tests use a fake bag-of-words embedder, so they verify **logic** (gates, weighting, thresholds) but not **semantic understanding** — proving that "Kubernetes" satisfies "container orchestration" requires the real bundled model and can only be checked by loading the actual extension (see the "semantic wins" case in `plan.md`'s verification section).

## Project layout
See `plan.md` for the full design rationale. Key pieces:
- `lib/experience.js` — deterministic regex experience-requirement parsing.
- `lib/matcher.js` — domain gate + semantic skill-coverage scoring + feedback (pure, no chrome/DOM deps).
- `lib/engine.js` — glues chrome.storage + the offscreen embedder to matcher.js.
- `offscreen/` — hosts the on-device MiniLM embedding model (ONNX + WASM).
- `content/` — scrapes the JD (auto-expanding "Read more") and renders the on-page overlay.
- `popup/` — resume upload (PDF via pdf.js), domain confirmation, experience-range slider, history.

## Before publishing to the Chrome Web Store
- Replace the placeholder icons in `icons/` (currently a plain generated circle) with real branding.
- Set the real Chrome Web Store review URL and feedback email in `content/content_script.js` (`wireFooterLinks`) and `popup/popup.js` (footer links) — currently placeholders (`YOUR_EXTENSION_ID`, `feedback@example.com`).
- Write the privacy policy and host-permission justification (see `plan.md` §12 in the original product plan for the exact language to use).

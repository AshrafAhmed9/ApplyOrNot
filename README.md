# ApplyOrNot

An AI recruiter in your browser. Upload your resume once; on any job listing, click **Check fit** and it gives a binary **APPLY / SKIP** verdict — one factual sentence, plus an expandable list of real gaps. Written like a neutral internal screening note, not a compliment — no match percentage, no keyword soup, no praise. On a page with no job description, it plainly says so instead of guessing.

## How it works

- **Local:** scrapes the best-available text from the page (auto-expanding "Read more", stripping site UI chrome) — see `lib/scraper.js`. Nothing is sent anywhere until you click.
- **Click-to-run:** the overlay starts as a small idle pill that makes **zero** network calls. A verdict only runs when you click **Check fit** — this is the single biggest cost/latency saver, since tokens are only ever spent on jobs you actually chose to check. Navigating to a new listing (SPA nav) resets to a fresh idle pill, not an auto-run.
- **Two-stage AI judgment, not one:**
  1. **Detect** — a profile-blind call decides whether the page is actually a genuine job posting (an employer offering a role, with responsibilities/requirements aimed at an applicant), using *only* the scraped text and title — it never sees the candidate's resume. This is deliberate: an earlier design that judged fit and JD-detection in one call let the candidate's own skills/projects bias detection (e.g. a candidate's own project README on a topic matching their resume was mistaken for a job posting). Keeping detection profile-blind eliminates that failure mode structurally, not just by prompt wording. If it's not a real posting, the overlay shows **"No job description detected"** and no further call is made.
  2. **Fit** — only for text the detector confirmed is a genuine posting: a second call judges experience/seniority fit, hard gates (degree/license/work authorization), then real capability match, leaning **APPLY** on genuinely borderline cases (a wasted application costs minutes; a wrongly-skipped one costs an opportunity).
- **Any AI provider, your choice:** by default calls go through a developer-funded Cloudflare Worker running Gemini 2.5 Flash (free, no signup). Paste your own API key in Settings to bypass the shared daily limit — the provider (Gemini, OpenAI, Anthropic, Groq, or OpenRouter) is auto-detected from the key's format, no dropdown needed.
- **Token/latency efficiency:** the resume is parsed into a compact profile **once** (never re-sent in full — and its extracted experience level/education are editable in the popup if the AI got them wrong), the JD is trimmed before sending, every verdict is cached locally (revisiting a listing costs nothing, and non-JD detections aren't cached since a page's content can still finish loading), few-shot calibration examples live in the static system prompt (not resent per call) for prompt caching, and outputs are capped (`maxOutputTokens`) since output generation is sequential and the biggest lever on speed.

## 1. Deploy the Cloudflare Worker (one-time, do this first)

The extension needs a live Worker URL before verdicts will work.

1. `cd worker && npx wrangler login`
2. Create the rate-limit KV store: `npx wrangler kv namespace create RATE_LIMIT` (and `--preview` for the preview id) — paste both ids into `worker/wrangler.toml`.
3. Get a free Gemini API key at [aistudio.google.com/apikey](https://aistudio.google.com/apikey), then: `npx wrangler secret put GEMINI_API_KEY`.
4. `npx wrangler deploy` — copy the printed `https://applyornot-api.<your-subdomain>.workers.dev` URL.
5. Paste that URL into `WORKER_BASE_URL` in `lib/llm.js`.
6. If you deploy to a custom domain instead of `*.workers.dev`, also update the `host_permissions` entry in `manifest.json`.

## 2. Load the extension locally (macOS Chrome)

1. Open `chrome://extensions`, toggle **Developer mode**, click **Load unpacked**, select this project folder.
2. Click the **ApplyOrNot** toolbar icon → **Upload Resume** (PDF). This makes one AI call to build a compact candidate profile (experience level, education, domains, skills, projects) — the raw resume text is never sent again after this. If the AI's extracted experience level or education looks wrong, edit it directly in the popup; the correction is used for every future verdict.
3. Set your **target experience range** slider.
4. The idle pill appears bottom-right on **any** page (draggable, hideable) — it makes no network call. Click **Check fit** to run a verdict on any site — there's no fixed list of supported job boards. On a non-job page, clicking it honestly reports "No job description detected."
5. Click through other listings in the same session — each new listing resets to a fresh idle pill; click **Check fit** again when you want a verdict for it.

### What to check while testing
- The idle pill itself must trigger **zero** network requests (check DevTools Network) — only clicking "Check fit" should call the Worker.
- A fresh verdict takes a couple of network round trips (detect, then fit) — cached or non-JD results are effectively instant.
- Open the page console (F12) for `[ApplyOrNot]` errors from `content_script.js` if the overlay shows "Couldn't get a verdict."
- Right-click the toolbar icon → **Inspect popup** to debug the upload/profile flow.
- After any code change: refresh the extension card in `chrome://extensions`, then reload the job-listing tab. Worker-side changes (prompts, routes) also need `cd worker && npx wrangler deploy` — editing `worker/*.js` alone does nothing until deployed.

## Project layout
- `worker/` — Cloudflare Worker: holds the Gemini API key, rate-limits by IP, exposes `POST /profile` and `POST /verdict` (which internally runs the detect-then-fit two-stage call). Prompts live in `worker/prompts.js` so they can be tuned without shipping a new extension version.
- `lib/llm.js` — thin extension-side client; calls the Worker by default, or routes directly to the user's own API key (auto-detecting the provider) if one is set in Settings (BYOK).
- `lib/prompts.js` — client-side copy of the prompts, kept byte-identical to `worker/prompts.js`, used only on the BYOK direct-call path.
- `lib/cache.js` — hashes the JD text and caches the AI's own verdict in `chrome.storage.local`.
- `lib/scraper.js` — extracts the best-available page text (Tier-1 site selectors → generic "description"-class fallback → Readability → whole-page last resort), auto-expands "Read more", strips site UI chrome. Does **not** decide whether the text is a job posting — that's left entirely to the AI's detect stage.
- `content/` — renders the on-page overlay (draggable, collapsible, hideable) and drives the scrape → cache-check → verdict flow.
- `popup/` — resume upload → AI profile extraction (with editable level/education), target-experience slider, overlay on/off, BYOK key field.

## Privacy
The candidate **profile** (not the raw resume) and the trimmed page text are sent to an AI provider to produce each verdict — only when you click "Check fit," never automatically. See `PRIVACY.md` for the full disclosure, including what the Worker stores (nothing but a rate-limit counter) and what changes if you use your own API key.

## Before publishing to the Chrome Web Store
- Deploy the Worker and set the real `WORKER_BASE_URL` in `lib/llm.js` (see step 1 above).
- Privacy policy is written (`PRIVACY.md`) — host it at a public URL (e.g. GitHub raw link, or a
  GitHub Pages page) and paste that URL into the Chrome Web Store listing's privacy policy field.
- Set `EXTENSION_ID` (in `content/content_script.js` and `popup/popup.js`) to the real ID Chrome
  assigns after your **first** submission, so the Rate link works — it's hidden by default until set.
- Submission copy (listing description, category, permission justification, data-use disclosure
  answers) is in `STORE_LISTING.md` — use it directly in the Web Store submission form.
- `manifest.json` requests `<all_urls>` (so the idle pill can appear on any job site, not just a fixed list) — this is a broad permission that Chrome Web Store review scrutinizes closely. Be ready to justify it in the listing: the content script only renders a passive UI element and never sends data anywhere until the user explicitly clicks "Check fit".

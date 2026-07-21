# ApplyOrNot

An AI recruiter in your browser. Upload your resume once; on any job listing, click **Check fit** and it reads the JD and gives a binary **APPLY / SKIP** verdict — one factual sentence, plus an expandable list of real gaps. Written like a neutral internal screening note, not a compliment — no match percentage, no keyword soup, no praise.

## How it works

- **Local:** scrapes the full job description (auto-expanding "Read more", stripping site UI chrome) — see `lib/scraper.js`. Nothing is sent anywhere until you click.
- **Click-to-run:** the overlay starts as a small idle pill that makes **zero** network calls. A verdict only runs when you click **Check fit** — this is the single biggest cost/latency saver, since tokens are only ever spent on jobs you actually chose to check. Navigating to a new listing (SPA nav) resets to a fresh idle pill, not an auto-run.
- **AI:** a single Gemini 2.5 Flash call judges fit like a senior hiring manager would — experience/seniority fit, hard gates (degree/license/authorization), then real capability match. It leans **APPLY** on genuinely borderline cases, since a wasted application costs minutes but a wrongly-skipped one costs an opportunity. Output is deliberately lean (`decision`, `confidence`, `reason`, `gaps` — no praise/strengths/suggestions sections) and capped (`maxOutputTokens`), which is what keeps it fast: output generation is sequential, so a smaller response is the biggest lever on speed.
- **Free / no signup:** calls go through a developer-funded Cloudflare Worker that hides the API key (see `worker/`). Users can optionally paste their own free Gemini key in Settings (BYOK) to bypass the shared daily limit entirely.
- **Token/latency efficiency:** the resume is parsed into a compact profile **once** (never re-sent in full), the JD is trimmed of boilerplate before sending, every verdict is cached locally (revisiting a listing costs nothing), and nothing runs until you click.

## 1. Deploy the Cloudflare Worker (one-time, do this first)

The extension needs a live Worker URL before verdicts will work.

1. `cd worker && npx wrangler login`
2. Create the rate-limit KV store: `npx wrangler kv:namespace create RATE_LIMIT` (and `--preview` for the preview id) — paste both ids into `worker/wrangler.toml`.
3. Get a free Gemini API key at [aistudio.google.com/apikey](https://aistudio.google.com/apikey), then: `npx wrangler secret put GEMINI_API_KEY`.
4. `npx wrangler deploy` — copy the printed `https://applyornot-api.<your-subdomain>.workers.dev` URL.
5. Paste that URL into `WORKER_BASE_URL` in `lib/llm.js`.
6. If you deploy to a custom domain instead of `*.workers.dev`, also update the `host_permissions` entry in `manifest.json`.

## 2. Load the extension locally (macOS Chrome)

1. Open `chrome://extensions`, toggle **Developer mode**, click **Load unpacked**, select this project folder.
2. Click the **ApplyOrNot** toolbar icon → **Upload Resume** (PDF). This makes one AI call to build a compact candidate profile (experience level, education, domains, skills, projects) — the raw resume text is never sent again after this.
3. Set your **target experience range** slider.
4. The idle pill appears bottom-right on **any** page (draggable, hideable) — it makes no network call. On a real job listing (LinkedIn/Indeed/Greenhouse/Lever/Workday/Ashby/iCIMS, or any other site — a generic fallback scraper handles unknown sites), click **Check fit** to run a verdict. On a non-job page, clicking it will honestly report "No job description detected."
5. Click through other listings in the same session — each new listing resets to a fresh idle pill; click **Check fit** again when you want a verdict for it.

### What to check while testing
- The idle pill itself must trigger **zero** network requests (check DevTools Network) — only clicking "Check fit" should call the Worker.
- A fresh verdict takes ~2–4s (one network round trip, output-capped for speed); revisiting the same listing is instant (cached).
- Open the page console (F12) for `[ApplyOrNot]` errors from `content_script.js` if the overlay shows "Couldn't get a verdict."
- Right-click the toolbar icon → **Inspect popup** to debug the upload/profile flow.
- After any code change: refresh the extension card in `chrome://extensions`, then reload the job-listing tab.

## Project layout
- `worker/` — Cloudflare Worker: holds the Gemini API key, rate-limits by IP, exposes `POST /profile` and `POST /verdict`. Prompts live in `worker/prompts.js` so they can be tuned without shipping a new extension version.
- `lib/llm.js` — thin extension-side client; calls the Worker by default, or Gemini directly if the user has set a personal API key (BYOK).
- `lib/prompts.js` — client-side copy of the prompts, used only on the BYOK direct-call path.
- `lib/cache.js` — hashes the JD text and caches the AI's own verdict in `chrome.storage.local`.
- `lib/scraper.js` — JD text extraction (Tier-1 site selectors → generic "description"-class fallback → Readability), auto-expands "Read more", strips site UI chrome.
- `content/` — renders the on-page overlay (draggable, collapsible, hideable) and drives the scrape → cache-check → verdict flow.
- `popup/` — resume upload → AI profile extraction, target-experience slider, overlay on/off, BYOK key field.

## Privacy
The candidate **profile** (not the raw resume) and the trimmed JD text are sent to Gemini to produce each verdict. This is a deliberate tradeoff for judgment quality — plain keyword/embedding matching couldn't reliably tell "the candidate's project is equivalent experience" from "the candidate literally lacks this skill." State this plainly in the store listing.

## Before publishing to the Chrome Web Store
- Deploy the Worker and set the real `WORKER_BASE_URL` in `lib/llm.js` (see step 1 above).
- Replace the placeholder icons in `icons/` with real branding.
- Set the real Chrome Web Store review URL and feedback email in `content/content_script.js` (`wireFooterLinks`) and `popup/popup.js` — currently placeholders (`YOUR_EXTENSION_ID`, `feedback@example.com`).
- Write the privacy policy disclosing that profile + JD text are sent to Google's Gemini API.
- `manifest.json` requests `<all_urls>` (so the idle pill can appear on any job site, not just a fixed list) — this is a broad permission that Chrome Web Store review scrutinizes closely. Be ready to justify it in the listing: the content script only renders a passive UI element and never sends data anywhere until the user explicitly clicks "Check fit".

# ApplyOrNot

An AI recruiter in your browser. Upload your resume once; on any job listing, it reads the JD and gives a binary **APPLY / SKIP** verdict with a one-sentence reason and an expandable "Why" (strengths, concerns, missing hard requirements, resume suggestions) — no match percentage, no keyword soup.

## How it works

- **Local:** scrapes the full job description (auto-expanding "Read more", stripping site UI chrome) — see `lib/scraper.js`.
- **AI:** a single Gemini 2.5 Flash call judges fit like a senior hiring manager would — experience/seniority fit, hard gates (degree/license/authorization), then real capability match. It leans **APPLY** on genuinely borderline cases, since a wasted application costs minutes but a wrongly-skipped one costs an opportunity.
- **Free / no signup:** calls go through a developer-funded Cloudflare Worker that hides the API key (see `worker/`). Users can optionally paste their own free Gemini key in Settings (BYOK) to bypass the shared daily limit entirely.
- **Token/latency efficiency:** the resume is parsed into a compact profile **once** (never re-sent in full), the JD is trimmed of boilerplate before sending, and every verdict is cached locally — revisiting a listing costs nothing.

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
4. Open a real job listing (LinkedIn/Indeed/Greenhouse/Lever/Workday/Ashby/iCIMS, or any other site — a generic fallback scraper handles unknown sites). The verdict overlay appears automatically, bottom-right, draggable, collapsible.
5. Click through other listings in the same session — the overlay refreshes itself automatically on SPA navigation.

### What to check while testing
- First verdict on a fresh listing takes ~1–3s (one network round trip); revisiting the same listing is instant (cached).
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

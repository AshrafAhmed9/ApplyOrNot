# Chrome Web Store Submission Kit

Everything needed to fill out the Web Store Developer Dashboard listing form for ApplyOrNot.

## Listing copy

**Title:** ApplyOrNot — AI Recruiter for Job Listings

**Category:** Productivity

**Short description** (≤132 chars):
> An AI recruiter in your browser: reads any job listing and your resume, then tells you plainly whether it's worth applying.

**Full description:**
> ApplyOrNot reads the job listing on the page you're viewing and gives you a plain **APPLY / SKIP**
> verdict — one factual sentence, plus an expandable list of real gaps. No match percentage, no
> keyword soup, no forced positivity. Written like a neutral internal hiring-team screening note.
>
> **How it works**
> - Upload your resume once. It's read locally in your browser; a compact profile (experience
>   level, education, domains, skills, projects) is extracted once and stored on your device — the
>   raw resume text is never sent again after that.
> - On any job listing, click "Check fit." A single AI call judges the fit like a hiring manager
>   would: experience/seniority match, hard requirements (degree, license, work authorization), then
>   real capability match — crediting equivalent experience even when it's worded differently.
> - Nothing runs until you click. The idle pill on every page makes zero network requests by
>   itself, and revisiting a listing you've already checked is instant (cached locally).
> - Works on any site — not just a fixed list of job boards. On a page with no job description,
>   it plainly says so instead of guessing.
> - Free, no signup. Optionally paste your own free API key (Gemini, OpenAI, Anthropic, Groq, or
>   OpenRouter — auto-detected) to bypass the shared daily limit entirely.
>
> **Privacy:** see our privacy policy for exactly what's sent and to whom. In short: your resume
> profile and the job listing's text are sent to an AI provider only when you click "Check fit" —
> never automatically, never sold, never used for anything else.

**Screenshots to capture** (1280×800 or 640×400, PNG):
1. Popup with an uploaded resume profile showing experience level, education, domains, skills.
2. The idle "Check fit" pill on a real job listing page.
3. An APPLY verdict card with a reason and expanded "Details" gaps.
4. A SKIP verdict card, showing the neutral/factual tone.
5. (Optional) The Settings section showing the BYOK key field and overlay toggle.

## Permission justification (for the review form / "why do you need this permission")

**`<all_urls>` (host permission + content script matches):**
> The extension needs to detect and read job description text on any website the user might
> browse to — job boards vary widely and cannot be limited to a fixed list. The content script
> injected on every page only renders a small, passive, dismissible UI element (an idle "Check
> fit" pill). It makes **no network requests of any kind** until the user explicitly clicks that
> button on a specific listing. On pages with no job description, clicking it returns "No job
> description detected" and nothing is sent anywhere.

**`storage`:**
> Used to store the user's own resume-derived profile, preferences, and cached verdicts locally
> on their device (`chrome.storage.local`) — never synced to any server we control.

**Remote hosts (`*.workers.dev`, `generativelanguage.googleapis.com`, `api.openai.com`,
`api.anthropic.com`, `api.groq.com`, `openrouter.ai`):**
> Needed to send the (compact, user-initiated) profile + job-description text to an AI provider
> for a verdict, and to reach our Cloudflare Worker on the free/no-signup path. Direct-provider
> hosts are only contacted if the user has pasted their own personal API key in Settings (BYOK).

## Data-use disclosure (Chrome Web Store "Privacy practices" form)

- **What is collected:** resume text (once, to build a profile), the derived profile, and
  scraped job-description text (only when the user clicks "Check fit"). No account, no
  identifiers beyond the requesting IP address (used solely for a daily per-IP rate-limit counter
  that auto-expires in our Worker's storage).
- **Purpose:** to produce the APPLY/SKIP verdict — no other use.
- **Sold / shared with third parties for advertising:** No.
- **Used for purposes unrelated to the item's core functionality:** No.
- **Used to determine creditworthiness or for lending purposes:** No.
- Full detail: link to `PRIVACY.md` (hosted at a public URL — see checklist below).

## Pre-submission checklist

- [ ] Deploy the Cloudflare Worker and set the real `WORKER_BASE_URL` in `lib/llm.js`.
- [ ] Host `PRIVACY.md` at a public URL (GitHub raw link, or GitHub Pages) and paste that URL into
      the Web Store listing's privacy policy field.
- [ ] Take and upload the screenshots listed above.
- [ ] Fill in the data-use disclosure form using the answers above.
- [ ] Submit for review.
- [ ] After Chrome assigns the real extension ID, set `EXTENSION_ID` in both
      `content/content_script.js` and `popup/popup.js` so the "Rate" link works, then push a
      follow-up version.
- [ ] Run manual QA: spot-check 15–20 real verdicts, and run the scraper against 20–30 real
      listings across different sites, noting anything that breaks.

# Privacy Policy — ApplyOrNot

Last updated: 2026-07-22

ApplyOrNot is a Chrome extension that reads a job listing on the page you're viewing and gives
you an APPLY/SKIP verdict against your resume. This document explains exactly what data moves,
where, and why.

## What is stored locally, on your device

- **Your resume file** is parsed entirely in your browser (via `pdf.js`, running inside the
  extension). The raw file and its extracted text are **not stored** after the one-time profile
  extraction below, and are never sent anywhere except that single request.
- The **candidate profile** (experience level/years, education, domains, skills, notable projects,
  certifications) is stored in `chrome.storage.local` on your machine only. Chrome sync is not used.
- Your **target experience range**, **overlay on/off setting**, **optional personal API key**, and
  the **verdict cache** (so revisiting a listing doesn't re-run the AI) are also stored only in
  `chrome.storage.local`.
- Nothing above is readable by any website you visit, or by us — it never leaves your device except
  as described below.

## What is sent to an AI provider, and when

ApplyOrNot uses a large language model to make its judgment — this is a deliberate design choice
because plain keyword matching cannot reliably tell "equivalent experience worded differently" from
"a real gap," and produced unreliable results in earlier testing.

1. **Once, when you upload a resume**: the extracted resume text is sent to the AI provider to
   build the compact candidate profile described above. This happens once per resume upload/replace
   — the raw resume text is not sent again afterward.
2. **Only when you click "Check fit" on a listing**: the compact profile, your preferences, and the
   scraped job-description text are sent to the AI provider to produce a verdict. Nothing is sent
   automatically — the idle pill on every page makes **zero** network requests until you click.
3. **Revisiting a listing you've already checked** costs nothing — the prior verdict is read from
   your local cache, with no new request.

## Which AI provider receives this data

- **By default**, requests go through a Cloudflare Worker that we operate, which calls
  **Google's Gemini API**. The Worker holds the API key; it does not store your profile or JD text
  — see "What the Worker stores," below.
- **If you paste your own API key** (Settings → "Your own API key"), requests go **directly from
  your browser** to whichever provider your key belongs to (Google Gemini, OpenAI, Anthropic, Groq,
  or OpenRouter — auto-detected from the key format), bypassing our Worker entirely. In that case
  your data is governed by that provider's own terms and privacy policy, and we never see it.

In both cases, the data sent is the same: the compact profile + the trimmed job-description text —
never your raw resume file, and never anything else on the page you're viewing.

## What the Worker stores

The Cloudflare Worker that proxies the free/shared path stores **no** profile or job-description
content. The only thing it persists is a **daily request counter keyed by IP address**, used purely
to enforce a fair-use rate limit on the free tier (e.g. "60 verdicts per IP per day"). Each counter
automatically expires roughly 26 hours after it's written. No logs of your resume, profile, or job
text are retained by the Worker.

## What we do not do

- No analytics, tracking pixels, or third-party telemetry of any kind.
- We do not sell, rent, or share your data with anyone.
- We do not use your data to train any model.
- We do not require an account or sign-up.

## Your controls

- Delete your profile and cache at any time by removing the extension, or by clearing extension
  storage via `chrome://extensions`.
- Turn the overlay off entirely in Settings.
- Use your own API key to bypass our Worker and shared rate limit completely.

## Contact

Questions or concerns: **ashrafahmed1232@gmail.com**

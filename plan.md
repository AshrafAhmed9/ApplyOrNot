# JD-Fit Chrome Extension — Build Plan

A fast, zero-backend Chrome extension that scans a job description against your resume(s), gives an instant **APPLY / DON'T APPLY** verdict, and flags experience and skill mismatches — built to get real users (Chrome Web Store installs) as a resume-worthy project.

---

## 1. Why this project (and the honest caveats)

**The goal:** ship a real product with real, verifiable users to add external validation to the resume — the one thing the profile lacks. Chrome Web Store install/WAU counts are clean, undeniable metrics.

**Why this idea survived scrutiny (earlier ideas didn't):**
- Real, self-identified pain point: as a fresher, time is wasted applying to experience-gated JDs that were never open to freshers. A tool that says "don't bother, this needs 3+ yrs" saves real time.
- Triggered at the exact use-moment (on the JD page), not a separate site to remember.
- Chrome Web Store is its own discovery channel independent of Reddit.
- Installs = an unambiguous resume metric.
- Differentiator vs Jobscan: **speed + no signup + on-device**. Jobscan is slow (server round-trip per scan, account gate). This runs client-side in milliseconds.

**Caveats to keep honest (do not lose sight of these):**
- User acquisition is hard and luck-dependent; most solo tools get near-zero traction through no fault of the build. This is a real risk, not a guaranteed win.
- This is a **Project (~10% lever)**, not a substitute for the higher-ROI work (DSA ~40%, real experience ~30%, live code-defense ~20%).
- Hard cap: **evenings only, ~1 week, DSA mornings untouched.** If it isn't growing after a short seeding window, it ships as-is and effort stops.
- **Goes under Projects on the resume, never Experience** — solo build, no employer, no team. Employer-shaped headings invite the "who hired you?" probe and don't survive it.

---

## 2. Product definition

**One-line:** On any LinkedIn/Indeed job page, instantly show whether it's worth applying to — experience gate first, skill match second — comparing against one or more uploaded resumes and auto-picking the best-fit one.

**Core verdict philosophy:**
- **Experience is the gate.** If experience fails, show only the red DON'T APPLY state — no skill breakdown, because it's moot.
- One number, one verdict, two lists (missing / matched). No multi-metric score soup (the flaw that made Jobscan feel like a black box).
- Colors: green = APPLY, red = DON'T APPLY, grey/neutral = experience unknown. No amber "maybe" tier — the user wants a decision.

---

## 3. Feature set

### Must-have (MVP — without these it's a demo)

1. **Confidence-aware experience parsing.** Distinguish "3+ years required" (hard block) from "3+ years preferred/nice-to-have/plus" (soft flag, still show score). The qualifying word near the number changes the verdict. This is the single feature separating a real tool from keyword soup.

2. **Weighted skill matching.** Parse JD by subsection ("Requirements" vs "Nice to have") and weight required > preferred. Prevents a JD needing 2 critical skills from scoring the same as one with 2 critical + 13 wishlist buzzwords.

3. **Per-site scan history** (`chrome.storage.local`). Log company, verdict, score, timestamp for the last ~20 JDs. Turns single-use into a habit loop.

4. **One-click "why" breakdown.** Expandable: matched skills, missing skills, and the exact JD sentence that triggered the experience flag. Showing the work builds trust.

### Strong nice-to-have (after MVP works)

5. **Multi-resume support.** Cache 2–3 resume versions (e.g. Backend / AI-ML / Reliability). Auto-run the matcher against all, pick the highest %, show it by default, and offer a side-by-side "compare other resumes" view. This is the strongest differentiator vs every competitor.

6. **Salary/location deal-breakers.** Same pattern as experience: regex for CTC ranges or on-site-only, configurable in settings.

### Explicitly cut (do NOT build)

- Accounts / cross-device sync — kills the no-signup edge.
- AI/LLM explanation — costs money, adds latency, defeats the "fast" positioning.
- Cover-letter generation, auto-apply — scope creep, different product.

---

## 4. Screens / UI states

### Screen 1 — First-run setup (popup, one-time)
- "Upload Resume" button (repeatable for multiple resumes).
- Each upload: PDF → parsed via pdf.js → extracted skills shown as **editable tags** (add a missed skill, remove a wrong one) → user labels it ("Backend", "AI/ML", etc.).
- Stored as an array of `{id, label, skills[], rawText}`.

### Screen 2 — On-page badge (injected on the JD page — the core experience)

APPLY case:
```
┌─────────────────────────────────┐
│  🟢 APPLY          82% match     │
│  Best resume: "Backend"          │
├─────────────────────────────────┤
│  Experience:  ✅ 0-2 yrs         │
│                                   │
│  Missing:                        │
│   • Kubernetes                   │
│   • gRPC                         │
│                                   │
│  ▸ Matched skills (expand)       │
│  ▸ Compare other resumes         │
└─────────────────────────────────┘
```

DON'T APPLY (experience gate fails — nothing else shown):
```
┌─────────────────────────────────┐
│  🔴 DON'T APPLY                  │
├─────────────────────────────────┤
│  Experience: ❌ Requires 3+ yrs   │
│  (you're a fresher)              │
└─────────────────────────────────┘
```

- Fixed-position badge, small, bottom-right, never covers page content, click to expand/collapse.
- **Best-resume auto-select:** run matcher against every stored resume, default to highest %.
- **"Compare other resumes":** expands to show each resume's % side by side (e.g. Backend 82%, AI/ML 61%).

### Screen 3 — Popup (click icon anytime)
- Saved resumes list with edit/delete.
- Recent scans (last 20): company, verdict, %, date.
- Settings: toggle sites, experience threshold, **user's own experience level**.

---

## 5. Experience-level handling

**Settings field (one-time):**
```
Your experience level:
  ○ Fresher (0 yrs)   ○ 0-1 yrs   ○ 1-2 yrs   [custom: ___ yrs]
```
Replaces the hardcoded "0" so the matcher compares JD-required years against the user's actual value.

**JDs that don't state experience — three-tier fallback (silence ≠ "yes"):**

1. **No number at all** → show experience as ⚪ "Not specified" (neutral, NOT a green pass). Still compute and show skill-match %, but leave the gate neutral.
2. **Seniority words without a number** → second keyword pass: "senior/lead/staff/principal" ⇒ implicit high requirement (red); "junior/entry-level/graduate/fresher/new grad" ⇒ implicit pass (green).
3. **Conflicting signals** (title says Senior, body says 0-2 yrs) → explicit years in body **beats** title keyword; surface both: "⚠ Title says Senior, but requirements list 0-2 yrs — verify manually."

**Verdict logic:**
```js
function getExperienceVerdict(jd, userExpYears) {
  const explicitYears = extractExperienceYears(jd);
  if (explicitYears !== null) {
    return explicitYears > userExpYears + 0.5
      ? { status: "FAIL", label: `Requires ${explicitYears}+ yrs` }
      : { status: "PASS", label: `${explicitYears} yrs OK` };
  }
  const seniorityFlag = detectSeniorityKeywords(jd); // 'senior' | 'junior' | null
  if (seniorityFlag === 'senior') return { status: "FAIL", label: "Senior role (no years stated)" };
  if (seniorityFlag === 'junior') return { status: "PASS",  label: "Entry-level (no years stated)" };
  return { status: "UNKNOWN", label: "Experience not specified — check manually" };
}
```
UNKNOWN renders grey/neutral — honest about JDs that genuinely don't say, without forcing a false binary.

---

## 6. Core matching logic

```js
function getVerdict(jd, resume, userExpYears) {
  // 1. Experience gate first
  const exp = getExperienceVerdict(jd, userExpYears);
  if (exp.status === "FAIL") return { verdict: "DON'T APPLY", reason: exp.label };

  // 2. Skill match (weighted: required > preferred)
  const jdSkills     = extractSkills(jd);         // vs static skills dictionary
  const resumeSkills = resume.skills;             // parsed once at upload
  const missing      = jdSkills.filter(s => !resumeSkills.includes(s));
  const matchPct     = (jdSkills.length - missing.length) / jdSkills.length;

  if (matchPct < 0.4) return { verdict: "DON'T APPLY", reason: `Missing: ${missing.join(', ')}` };
  return {
    verdict: "APPLY",
    matchPct: Math.round(matchPct * 100),
    missing,
    expLabel: exp.label   // PASS or UNKNOWN
  };
}
```

**Why it's fast (the differentiator):**

| Jobscan (slow) | This (fast) |
|---|---|
| Uploads resume to a server every scan | Resume parsed once, cached locally |
| Server-side NLP/API per JD | Regex + dictionary lookup, on-device |
| Network round-trip each time | Zero network calls after load |
| Account/auth per request | No signup, no auth |

Regex + array comparison over ~250 dictionary terms against a few-hundred-word JD runs in single-digit milliseconds. Only perceptible latency is the DOM waiting for the JD to render (normal page speed, not our code).

---

## 7. Tech stack

- **Manifest V3** (required by Chrome Web Store).
- **Vanilla JS** — no React; a build step adds complexity for zero benefit at this scope.
- **pdf.js** (Mozilla) — client-side resume PDF parsing, nothing uploaded anywhere.
- **chrome.storage.local** — resumes, scan history, settings; persists across sessions.
- **Static JSON** — hand-curated skills dictionary (~250 SWE/backend terms).
- **No server, no DB, no API cost, no hosting.** Ships as a `.zip` to the store.

---

## 8. Data model

```js
{
  resumes: [
    { id: "r1", label: "Backend", skills: [...], rawText: "..." },
    { id: "r2", label: "AI/ML",   skills: [...], rawText: "..." }
  ],
  scanHistory: [
    { company, jdUrl, verdict, bestResumeId, matchPct, missingSkills:[], timestamp }
  ],
  settings: {
    sites: { linkedin: true, indeed: true },
    userExpYears: 0,
    expThresholdYears: 0.5
  }
}
```

---

## 9. Always-on / auto-refresh behavior

Content scripts auto-inject on matching pages — **no click needed** for the badge. The icon click is only for one-time resume setup.

**Problem:** LinkedIn/Indeed are SPAs — clicking between listings changes the URL via JS routing without a full reload, so a one-shot content script goes stale.

**Fix — watch for URL/DOM changes:**
```js
let lastUrl = location.href;

function checkAndRun() {
  if (location.href !== lastUrl) {
    lastUrl = location.href;
    setTimeout(runMatcher, 500); // let the new JD render first
  }
}

new MutationObserver(checkAndRun).observe(document.body, { childList: true, subtree: true });
runMatcher(); // also run once on first load
```
The URL guard stops it re-running on every chatty DOM mutation; it only fires when the URL actually changes. Standard SPA content-script pattern.

**Manifest content-script registration:**
```json
"content_scripts": [{
  "matches": ["*://*.linkedin.com/jobs/*", "*://*.indeed.com/*"],
  "js": ["matcher.js", "content_script.js"],
  "run_at": "document_idle"
}]
```

---

## 10. Build procedure & timeline

**Sites:** start with **LinkedIn + Indeed**, expand later. Each site needs its own DOM selector map (their markup differs); this is the most fragile, unpredictable part.

| Day | Task |
|---|---|
| 1 | manifest.json + skills-dictionary.json + popup resume upload/parse (pdf.js) |
| 2 | matcher.js — experience regex + seniority keywords + weighted skill match + verdict |
| 3 | LinkedIn content script (DOM scrape + badge injection + MutationObserver) |
| 4 | Indeed content script (reuse matcher, new selectors) + multi-resume compare view |
| 5 | Test on 20+ real JDs per site, fix selector breakage, polish badge UI |
| 6 | Package, write store listing + privacy policy, submit |

- **~6 active evenings.** Multi-resume adds roughly +1 day beyond the original 6-day MVP — worth it as the strongest feature (confirm the cap before committing).
- Ongoing cost: selector maintenance when sites change DOM — budget ~an hour every few weeks, not a rebuild.

---

## 11. Local testing (no store needed)

1. Build the folder locally (manifest.json + scripts).
2. `chrome://extensions` → toggle **Developer mode** → **Load unpacked** → select the folder.
3. Appears in toolbar immediately.
4. On code change: refresh the extension card, then reload the JD tab (content-script changes need the page reloaded too).
5. Debug: right-click icon → "Inspect popup" for popup JS; F12 → Console on the JD page for content-script logs; "Errors" button on the extension card for manifest load failures.

All 6 build days happen here; the store submission only happens once it works locally on real pages.

---

## 12. Chrome Web Store launch

- **$5 one-time developer registration**, instant.
- First-time submissions get more scrutiny than updates: typically **1–3 business days**, occasionally up to a week; no guaranteed SLA.
- Rejection adds another 1–3 days — avoid it by preparing up front:
  - **Privacy policy** (free GitHub Pages page): resume data is "processed entirely on-device, never transmitted" — true, and exactly what reviewers want.
  - **Justify host permissions** explicitly in the listing: "required to read job-description text from LinkedIn/Indeed pages you visit." Vague justification is the #1 rejection reason for this permission type.
- **Realistic total: ~10–14 days tonight → live**, of which only ~6 evenings is actual work; the rest is passive review waiting.

---

## 13. Metrics & resume framing

**Analytics — mostly free/native:**
- Chrome Web Store Developer Dashboard gives **Weekly Active Users** and daily install/uninstall counts automatically, no code. Dashboard screenshot = proof.
- Optional DAU precision: one `chrome.storage` `last_active_date` check in the content script — but the built-in WAU is enough for a resume line; don't over-engineer.

**Install benchmark (solo, organic, no budget):**

| Installs | Reads as |
|---|---|
| <50 | Skip mentioning |
| 100–500 | "Built and shipped" — honest, low signal |
| 500–2,000 | Genuinely good for organic-only — worth a bullet |
| 2,000+ | Strong — most personal extensions never get here without a big launch |

**Realistic target:** 300–1,000 installs with a launch post on r/chrome_extensions, r/cscareerquestions, r/developersIndia, and LinkedIn.

**Resume line (Projects section, NOT Experience):**
> **Fresher JD-Fit Chrome Extension** | JavaScript, Chrome Extension APIs (Manifest V3), pdf.js
> Built a zero-backend Chrome extension that scores JD-resume fit and flags experience-requirement mismatches in real time on LinkedIn/Indeed — all parsing runs client-side (no server, no signup). 600+ installs, 150+ WAU (Chrome Web Store Developer Dashboard).

---

## 14. Marketing & distribution — every channel to launch on

**Core principle: distribution matters more than the build.** A technically perfect extension with zero promotion gets ~0 installs; a mediocre one seeded aggressively across the right channels gets hundreds. Budget real time for this — at least as many evenings as the build itself.

### Reddit (primary channel — highest leverage for this audience)
- **r/developersIndia** — biggest India-specific dev audience, directly your peer group, very receptive to "I built this because I was frustrated" posts
- **r/cscareerquestions** — huge, US-heavy but freshers everywhere lurk; post as "I built a tool to stop wasting time on JDs that don't want freshers"
- **r/EngineeringResumes** — resume-adjacent audience, will care about the JD-fit angle
- **r/csMajors** — student-heavy, fresher pain point lands well
- **r/chrome_extensions** — small but exactly the right niche audience, low competition for visibility
- **r/SideProject** — friendly first-post audience, good for early feedback before the bigger subs
- **r/webdev** — if you frame it around the technical build (client-side parsing, no backend)
- **r/india** or **r/bangalore** — only if framed casually, not a hard sell; local audience, could work as a soft mention
- **Timing/etiquette:** post build-story angle ("I built X because Y happened to me"), not "check out my product" — Reddit downvotes pure self-promo. One subreddit at a time, spaced out, read each sub's self-promo rules first (many require a specific day/flair).

### Other forums / communities
- **Indie Hackers** — community built exactly for "I shipped something, here's the traction" posts; good for follow-up momentum posts as installs grow
- **Hacker News (Show HN)** — high-quality traffic if it lands on the front page, but HN is unforgiving of anything that reads like a resume-padding project; frame purely as a technical build
- **Product Hunt** — a launch-day listing here is a legitimate install spike if timed well; needs a simple landing page/GIF ready
- **Discord servers** — dev-focused servers (e.g. "Techies" India dev Discords, The Programmer's Hangout, freeCodeCamp Discord) have off-topic/showcase channels
- **Telegram** — Indian placement/dev Telegram channels and groups (the same ecosystem discussed earlier for job-alert bots) — post there directly, high relevance to fresher job-hunters
- **LinkedIn** — post as a personal "I built this" story, tag it with your job search context; LinkedIn algorithm rewards authentic build-in-public posts, and recruiters/engineers in your network see it directly
- **Twitter/X** — #buildinpublic community, indie dev hashtags; less predictable but free and easy to try
- **Quora** — answer existing questions like "how do I know if I should apply to a JD as a fresher" and organically mention the tool as your answer's solution

### College / immediate network (your unfair advantage, don't skip this)
- **NHCE batchmates / WhatsApp placement groups** — direct, high-conversion audience since they have the exact same fresher-JD problem right now
- **VTU-wide placement groups / Telegram channels** — broader reach within the same student population
- **LinkedIn alumni network** — NHCE alumni, especially recent grads still job-hunting

### Chrome Web Store's own discovery
- Optimize the store listing itself as a channel: clear title ("Fresher Job-Fit Checker — Resume vs JD, Instant"), keyword-rich description, a short demo GIF, since people actively search/browse the store's "Productivity" category

### Sequencing (don't blast everywhere at once)
1. Day of launch: r/SideProject (friendly, low-stakes feedback) + Indie Hackers
2. Fix anything broken from early feedback
3. Days 2-4: r/developersIndia, r/cscareerquestions, r/csMajors, LinkedIn post, college WhatsApp/Telegram groups
4. Week 2: r/chrome_extensions, Product Hunt (if traction is building), Show HN (only if the build story is genuinely technical enough for that audience)
5. Ongoing: Quora answers, Twitter, ongoing Discord mentions where relevant — low-effort, drip it over weeks rather than one-time

### Resume framing this earns
If distribution actually lands, the resume line upgrades from a plain metric to a marketing-capable engineer signal:
> "...launched via organic multi-channel distribution (Reddit, Product Hunt, developer communities), reaching 600+ installs without paid acquisition."
That's a genuinely rare and valuable line for a fresher — most candidates can build; almost none can point to real organic distribution they drove themselves.

---

## 15. Open decisions before coding

1. **Scope cap:** hold to 1 week evenings (MVP only), or extend ~1 day for multi-resume in v1? (Multi-resume is the strongest differentiator.)
2. **Resume input v1:** PDF via pdf.js, or ship faster with "paste resume text once" and add PDF after? (Paste is simpler, gets you testing sooner.)
3. **This is a Project, ~10% lever** — confirm it's a deliberate choice for evening slots and not displacing the day's DSA / code-defense reps.

---

## 16. Priority reminder

DSA mornings are untouched and non-negotiable. This extension is evening work, hard-capped, and ships imperfect. If it isn't gaining installs after a short seeding window, it ships as-is and effort stops — the resume keeps the line either way, and attention returns to the levers that actually move callback rate (DSA, referrals, live code-defense).

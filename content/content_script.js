// Injects the persistent verdict overlay on job pages, auto-refreshing it
// whenever the SPA navigates to a new listing (LinkedIn/Indeed swap content
// without a full page reload).
(function () {
  const BADGE_ID = "aon-root";
  let lastUrl = location.href;
  let running = false;
  let collapsed = false;

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  function ensureRoot() {
    let root = document.getElementById(BADGE_ID);
    if (!root) {
      root = document.createElement("div");
      root.id = BADGE_ID;
      document.documentElement.appendChild(root);

      // Single delegated click handler with explicit, non-overlapping targets.
      root.addEventListener("click", (e) => {
        // Collapse/expand only via the dedicated chevron button.
        if (e.target.closest("[data-aon-collapse]")) {
          collapsed = !collapsed;
          root.classList.toggle("aon-collapsed", collapsed);
          return;
        }
        // Re-open when clicking the collapsed pill.
        if (collapsed && e.target.closest(".aon-card")) {
          collapsed = false;
          root.classList.remove("aon-collapsed");
          return;
        }
        // Details disclosure toggles independently; never collapses the card.
        const disc = e.target.closest("[data-aon-details]");
        if (disc) {
          const card = disc.closest(".aon-card");
          if (card) card.classList.toggle("aon-details-open");
        }
      });
    }
    return root;
  }

  function headerBar(stateClass, titleHtml) {
    return `<div class="aon-top ${stateClass}">
      <div class="aon-brand">
        <span class="aon-logo"></span>
        <span class="aon-title">${titleHtml}</span>
      </div>
      <button class="aon-chevron" data-aon-collapse aria-label="Collapse">
        <svg viewBox="0 0 16 16" width="14" height="14"><path d="M4 6l4 4 4-4" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>
      </button>
    </div>`;
  }

  function footerHtml() {
    return `<div class="aon-footer">
      <a href="#" data-aon-rate target="_blank" rel="noopener">★ Rate</a>
      <span class="aon-sep">·</span>
      <a href="#" data-aon-feedback target="_blank" rel="noopener">Feedback</a>
    </div>`;
  }

  function chips(items) {
    if (!items || !items.length) return "";
    return `<div class="aon-chips">${items.map((i) => `<span class="aon-chip">${escapeHtml(i)}</span>`).join("")}</div>`;
  }

  function render(html) {
    const root = ensureRoot();
    root.classList.toggle("aon-collapsed", collapsed);
    root.innerHTML = html;
    wireFooterLinks(root);
  }

  function renderLoading() {
    render(`<div class="aon-card aon-neutral">
      ${headerBar("", "ApplyOrNot")}
      <div class="aon-loading"><span class="aon-spinner"></span> Analyzing this role…</div>
    </div>`);
  }

  function renderNoResumes() {
    render(`<div class="aon-card aon-neutral">
      ${headerBar("", "ApplyOrNot")}
      <div class="aon-body">
        <div class="aon-empty-title">Upload a resume to begin</div>
        <div class="aon-empty-sub">Click the ApplyOrNot icon in your toolbar to add one.</div>
      </div>
      ${footerHtml()}
    </div>`);
  }

  function renderError() {
    render(`<div class="aon-card aon-neutral">
      ${headerBar("", "ApplyOrNot")}
      <div class="aon-body">
        <div class="aon-empty-title">Couldn't read this page</div>
        <div class="aon-empty-sub">No job description detected here yet.</div>
      </div>
      ${footerHtml()}
    </div>`);
  }

  function renderVerdict(best, all, resumeCount) {
    const v = best.verdict;
    const isApply = v.verdict === "APPLY";

    if (!isApply) {
      render(`<div class="aon-card aon-fail">
        ${headerBar("aon-fail-top", "Don't apply")}
        <div class="aon-verdict-row">
          <span class="aon-dot aon-dot-red"></span>
          <span class="aon-verdict-reason">${escapeHtml(v.reason)}</span>
        </div>
        ${footerHtml()}
      </div>`);
      return;
    }

    const bestLine =
      resumeCount > 1
        ? `<div class="aon-meta">Best résumé · <b>${escapeHtml(best.resume.label || "Resume")}</b></div>`
        : "";
    const noteLine = v.note ? `<div class="aon-note">${escapeHtml(v.note)}</div>` : "";
    const compareRows = all
      .slice()
      .sort((a, b) => (b.verdict.matchPct ?? 0) - (a.verdict.matchPct ?? 0))
      .map(
        (r) =>
          `<div class="aon-compare-row"><span>${escapeHtml(r.resume.label || "Resume")}</span><span class="aon-compare-pct">${r.verdict.matchPct ?? 0}%</span></div>`
      )
      .join("");

    render(`<div class="aon-card aon-apply">
      ${headerBar("aon-apply-top", "Apply")}
      <div class="aon-score">
        <div class="aon-ring" style="--pct:${v.matchPct}">
          <span class="aon-ring-num">${v.matchPct}<span class="aon-ring-pct">%</span></span>
        </div>
        <div class="aon-score-side">
          <div class="aon-verdict-row"><span class="aon-dot aon-dot-green"></span><span class="aon-verdict-word">Good match</span></div>
          ${bestLine}
          <div class="aon-meta">${escapeHtml(v.expLabel)}</div>
        </div>
      </div>
      ${noteLine}
      ${
        v.gaps && v.gaps.length
          ? `<div class="aon-section"><div class="aon-section-title">Missing requirements</div>${chips(v.gaps)}</div>`
          : `<div class="aon-section"><div class="aon-section-title">Requirements</div><div class="aon-allclear">✓ Full coverage</div></div>`
      }
      <button class="aon-details-toggle" data-aon-details>
        <span class="aon-details-label">Details</span>
        <svg class="aon-details-caret" viewBox="0 0 16 16" width="12" height="12"><path d="M4 6l4 4 4-4" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>
      </button>
      <div class="aon-details">
        ${v.strengths && v.strengths.length ? `<div class="aon-section-title">Matched strengths</div>${chips(v.strengths)}` : ""}
        ${v.niceToHaveGaps && v.niceToHaveGaps.length ? `<div class="aon-section-title">Nice-to-have gaps</div>${chips(v.niceToHaveGaps)}` : ""}
        ${resumeCount > 1 ? `<div class="aon-section-title">Compare résumés</div><div class="aon-compare">${compareRows}</div>` : ""}
        ${v.softSkillsFound && v.softSkillsFound.length ? `<div class="aon-section-title">Soft skills mentioned<span class="aon-info-tag">info only</span></div>${chips(v.softSkillsFound)}` : ""}
      </div>
      ${footerHtml()}
    </div>`);
  }

  function wireFooterLinks(root) {
    const rate = root.querySelector("[data-aon-rate]");
    const feedback = root.querySelector("[data-aon-feedback]");
    if (rate) rate.href = "https://chromewebstore.google.com/detail/YOUR_EXTENSION_ID/reviews";
    if (feedback) feedback.href = "mailto:feedback@example.com?subject=ApplyOrNot%20feedback";
  }

  async function getResumes() {
    const { resumes } = await chrome.storage.local.get("resumes");
    return resumes || [];
  }

  async function logScan(entry) {
    const { scanHistory } = await chrome.storage.local.get("scanHistory");
    const history = scanHistory || [];
    history.unshift(entry);
    await chrome.storage.local.set({ scanHistory: history.slice(0, 20) });
  }

  async function runMatcher() {
    if (running) return;
    running = true;
    try {
      const resumes = await getResumes();
      if (!resumes.length) {
        renderNoResumes();
        return;
      }
      renderLoading();
      const { text: jdText } = await ScraperLib.scrapeFullJD();
      if (!jdText || jdText.length < 40) {
        renderError();
        return;
      }
      const { best, all } = await EngineLib.scoreJD(jdText, resumes);
      renderVerdict(best, all, resumes.length);
      await logScan({
        company: document.title.slice(0, 120),
        jdUrl: location.href,
        verdict: best.verdict.verdict,
        bestResumeId: best.resume.id,
        matchPct: best.verdict.matchPct ?? null,
        missingSkills: best.verdict.gaps || [],
        timestamp: Date.now(),
      });
    } catch (err) {
      console.error("[ApplyOrNot] matcher error", err);
      renderError();
    } finally {
      running = false;
    }
  }

  function checkAndRun() {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      setTimeout(runMatcher, 600); // let the new JD render first
    }
  }

  new MutationObserver(checkAndRun).observe(document.body, { childList: true, subtree: true });
  runMatcher(); // also run once on first load
})();

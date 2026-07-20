// Injects the persistent verdict overlay on job pages, auto-refreshing it
// whenever the SPA navigates to a new listing (LinkedIn/Indeed swap content
// without a full page reload).
(function () {
  const BADGE_ID = "jdfit-badge-root";
  let lastUrl = location.href;
  let running = false;
  let collapsed = false;

  function el(tag, props = {}, children = []) {
    const node = document.createElement(tag);
    Object.entries(props).forEach(([k, v]) => {
      if (k === "class") node.className = v;
      else if (k === "html") node.innerHTML = v;
      else node.setAttribute(k, v);
    });
    children.forEach((c) => node.appendChild(c));
    return node;
  }

  function ensureBadgeRoot() {
    let root = document.getElementById(BADGE_ID);
    if (!root) {
      root = el("div", { id: BADGE_ID });
      document.documentElement.appendChild(root);
      root.addEventListener("click", (e) => {
        const toggle = e.target.closest("[data-jdfit-toggle]");
        if (toggle) {
          collapsed = !collapsed;
          root.classList.toggle("jdfit-collapsed", collapsed);
        }
        const details = e.target.closest("[data-jdfit-expand]");
        if (details) details.classList.toggle("jdfit-open");
      });
    }
    return root;
  }

  function renderLoading() {
    const root = ensureBadgeRoot();
    root.innerHTML = `<div class="jdfit-card jdfit-loading" data-jdfit-toggle>
      <div class="jdfit-header">Checking fit…</div>
    </div>`;
  }

  function renderNoResumes() {
    const root = ensureBadgeRoot();
    root.innerHTML = `<div class="jdfit-card jdfit-neutral" data-jdfit-toggle>
      <div class="jdfit-header">Upload a resume to get started</div>
      <div class="jdfit-body">Click the ApplyOrNot icon in your toolbar.</div>
      ${footerHtml()}
    </div>`;
  }

  function footerHtml() {
    return `<div class="jdfit-footer">
      <a href="#" data-jdfit-rate target="_blank" rel="noopener">⭐ Rate</a>
      <span class="jdfit-dot">·</span>
      <a href="#" data-jdfit-feedback target="_blank" rel="noopener">💬 Feedback</a>
    </div>`;
  }

  function listHtml(items, emptyText) {
    if (!items || !items.length) return `<div class="jdfit-empty">${emptyText}</div>`;
    return `<ul class="jdfit-list">${items.map((i) => `<li>${escapeHtml(i)}</li>`).join("")}</ul>`;
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  function renderVerdict(best, all, resumeCount) {
    const root = ensureBadgeRoot();
    const v = best.verdict;
    const isApply = v.verdict === "APPLY";
    root.classList.toggle("jdfit-collapsed", collapsed);

    if (!isApply) {
      root.innerHTML = `<div class="jdfit-card jdfit-fail" data-jdfit-toggle>
        <div class="jdfit-header">🔴 DON'T APPLY</div>
        <div class="jdfit-reason">${escapeHtml(v.reason)}</div>
        ${footerHtml()}
      </div>`;
      wireFooterLinks(root);
      return;
    }

    const bestLine = resumeCount > 1 ? `<div class="jdfit-best">Best resume: ${escapeHtml(best.resume.label || "Resume")}</div>` : "";
    const noteLine = v.note ? `<div class="jdfit-note">ℹ️ ${escapeHtml(v.note)}</div>` : "";
    const compareRows = all
      .map((r) => `<li>${escapeHtml(r.resume.label || "Resume")}: ${r.verdict.matchPct ?? 0}%</li>`)
      .join("");

    root.innerHTML = `<div class="jdfit-card jdfit-apply" data-jdfit-toggle>
      <div class="jdfit-header">🟢 APPLY <span class="jdfit-pct">${v.matchPct}% match</span></div>
      ${bestLine}
      <div class="jdfit-exp">Experience: ${escapeHtml(v.expLabel)}</div>
      ${noteLine}
      <div class="jdfit-section-title">Missing (required)</div>
      ${listHtml(v.gaps, "None — full coverage.")}
      <div data-jdfit-expand class="jdfit-expandable">
        <div class="jdfit-expand-toggle">▸ More details</div>
        <div class="jdfit-expand-body">
          <div class="jdfit-section-title">Matched strengths</div>
          ${listHtml(v.strengths, "—")}
          <div class="jdfit-section-title">Nice-to-have gaps</div>
          ${listHtml(v.niceToHaveGaps, "None")}
          ${resumeCount > 1 ? `<div class="jdfit-section-title">Compare resumes</div><ul class="jdfit-list">${compareRows}</ul>` : ""}
          ${v.softSkillsFound?.length ? `<div class="jdfit-section-title">Soft skills mentioned (info only)</div>${listHtml(v.softSkillsFound, "—")}` : ""}
        </div>
      </div>
      ${footerHtml()}
    </div>`;
    wireFooterLinks(root);
  }

  function wireFooterLinks(root) {
    const rate = root.querySelector("[data-jdfit-rate]");
    const feedback = root.querySelector("[data-jdfit-feedback]");
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
        renderNoResumes(); // not enough JD text found on this page yet
        return;
      }
      const { best, all } = await EngineLib.scoreJD(jdText, resumes);
      renderVerdict(best, all, resumes.length);
      await logScan({
        jdUrl: location.href,
        verdict: best.verdict.verdict,
        bestResumeId: best.resume.id,
        matchPct: best.verdict.matchPct ?? null,
        missingSkills: best.verdict.gaps || [],
        timestamp: Date.now(),
      });
    } catch (err) {
      console.error("[ApplyOrNot] matcher error", err);
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

// Injects a small idle pill on job pages — it makes NO network call on its own. The user
// clicks it to run a verdict (scrape -> cache-check -> single LLM call), which then expands
// into the full card. SPA navigation to a new listing (LinkedIn/Indeed swap content without
// a full page reload) resets back to the idle pill rather than auto-running, so tokens are
// only ever spent on jobs the user actually chooses to check. Draggable, collapsible,
// hideable. The verdict itself comes from a single LLM call (via lib/llm.js) grounded in
// the user's candidate profile + preferences — no local scoring; this file is presentation
// and triggering only.
(function () {
  const BADGE_ID = "aon-root";
  let lastUrl = location.href;
  let running = false;
  let collapsed = false;
  let overlayEnabled = true;

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  // ---------- Settings (overlay on/off) ----------
  async function loadOverlaySetting() {
    const { settings } = await chrome.storage.local.get("settings");
    overlayEnabled = settings?.showOverlay !== false;
  }
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local" || !changes.settings) return;
    const wasEnabled = overlayEnabled;
    overlayEnabled = changes.settings.newValue?.showOverlay !== false;
    const root = document.getElementById(BADGE_ID);
    if (!overlayEnabled && root) {
      root.style.display = "none";
    } else if (overlayEnabled && !wasEnabled) {
      if (root) root.style.display = "";
      resetToIdle();
    }
  });

  // ---------- Draggable position ----------
  async function loadPosition(root) {
    const { aonPosition } = await chrome.storage.local.get("aonPosition");
    if (aonPosition && typeof aonPosition.left === "number" && typeof aonPosition.top === "number") {
      root.style.left = `${aonPosition.left}px`;
      root.style.top = `${aonPosition.top}px`;
      root.style.right = "auto";
      root.style.bottom = "auto";
    }
  }

  function savePosition(left, top) {
    chrome.storage.local.set({ aonPosition: { left, top } });
  }

  function wireDrag(root) {
    let dragging = false;
    let startX = 0, startY = 0, startLeft = 0, startTop = 0;

    root.addEventListener("pointerdown", (e) => {
      const header = e.target.closest(".aon-top, .aon-idle-row");
      if (!header || e.target.closest("button, a")) return;
      dragging = true;
      const rect = root.getBoundingClientRect();
      startX = e.clientX;
      startY = e.clientY;
      startLeft = rect.left;
      startTop = rect.top;
      root.setPointerCapture(e.pointerId);
      root.classList.add("aon-dragging");
    });

    root.addEventListener("pointermove", (e) => {
      if (!dragging) return;
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      let left = startLeft + dx;
      let top = startTop + dy;
      const maxLeft = window.innerWidth - 60;
      const maxTop = window.innerHeight - 40;
      left = Math.max(-260, Math.min(left, maxLeft));
      top = Math.max(0, Math.min(top, maxTop));
      root.style.left = `${left}px`;
      root.style.top = `${top}px`;
      root.style.right = "auto";
      root.style.bottom = "auto";
    });

    function endDrag() {
      if (!dragging) return;
      dragging = false;
      root.classList.remove("aon-dragging");
      const rect = root.getBoundingClientRect();
      savePosition(rect.left, rect.top);
    }
    root.addEventListener("pointerup", endDrag);
    root.addEventListener("pointercancel", endDrag);
  }

  // ---------- Rendering ----------
  function ensureRoot() {
    let root = document.getElementById(BADGE_ID);
    if (!root) {
      root = document.createElement("div");
      root.id = BADGE_ID;
      document.documentElement.appendChild(root);
      loadPosition(root);
      wireDrag(root);

      root.addEventListener("click", (e) => {
        if (e.target.closest("[data-aon-check]")) {
          runVerdict();
          return;
        }
        if (e.target.closest("[data-aon-collapse]")) {
          collapsed = !collapsed;
          root.classList.toggle("aon-collapsed", collapsed);
          return;
        }
        if (collapsed && e.target.closest(".aon-card")) {
          collapsed = false;
          root.classList.remove("aon-collapsed");
          return;
        }
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

  function footerHtml(withReport) {
    return `<div class="aon-footer">
      <a href="#" data-aon-rate target="_blank" rel="noopener">★ Rate</a>
      <span class="aon-sep" data-aon-rate-sep>·</span>
      <a href="#" data-aon-feedback target="_blank" rel="noopener">★ Feedback</a>
      ${
        withReport
          ? `<span class="aon-sep">·</span><a href="#" data-aon-report target="_blank" rel="noopener">Report</a>`
          : ""
      }
    </div>`;
  }

  const CHIP_MAX_LEN = 90;
  function truncate(s) {
    return s.length > CHIP_MAX_LEN ? s.slice(0, CHIP_MAX_LEN - 1).trimEnd() + "…" : s;
  }

  function chips(items, variant) {
    if (!items || !items.length) return "";
    const cls = variant ? `aon-chip aon-chip-${variant}` : "aon-chip";
    return `<div class="aon-chips">${items.map((i) => `<span class="${cls}">${escapeHtml(truncate(i))}</span>`).join("")}</div>`;
  }

  function render(html) {
    const root = ensureRoot();
    root.classList.toggle("aon-collapsed", collapsed);
    root.innerHTML = html;
    wireFooterLinks(root);
  }

  /** Idle state: no network call has been made for this listing. Clicking runs the verdict. */
  function renderIdle() {
    render(`<div class="aon-card aon-neutral aon-idle">
      <div class="aon-idle-row">
        <span class="aon-logo"></span>
        <button class="aon-check-btn" data-aon-check>Check fit</button>
      </div>
    </div>`);
  }

  function renderLoading() {
    render(`<div class="aon-card aon-neutral">
      ${headerBar("", "ApplyOrNot")}
      <div class="aon-loading"><span class="aon-spinner"></span> Checking…</div>
    </div>`);
  }

  function renderNoProfile() {
    render(`<div class="aon-card aon-neutral">
      ${headerBar("", "ApplyOrNot")}
      <div class="aon-body">
        <div class="aon-empty-title">Upload a resume to begin</div>
        <div class="aon-empty-sub">Click the ApplyOrNot icon in your toolbar to add one.</div>
      </div>
      ${footerHtml()}
    </div>`);
  }

  function renderNoJD() {
    render(`<div class="aon-card aon-neutral">
      ${headerBar("", "ApplyOrNot")}
      <div class="aon-body">
        <div class="aon-empty-title">No job description detected</div>
        <div class="aon-empty-sub">This page doesn't look like a job posting.</div>
      </div>
      ${footerHtml()}
    </div>`);
  }

  function renderError(message) {
    render(`<div class="aon-card aon-neutral">
      ${headerBar("", "ApplyOrNot")}
      <div class="aon-body">
        <div class="aon-empty-title">Couldn't get a verdict</div>
        <div class="aon-empty-sub">${escapeHtml(message)}</div>
      </div>
      ${footerHtml()}
    </div>`);
  }

  // Empty until the Web Store assigns a real ID on first publish — see README "Before publishing".
  const EXTENSION_ID = "";

  let lastVerdictContext = null; // { pageUrl, decision, reason } — for the Report link

  function renderVerdict(v) {
    // Normalize defensively: the model is asked for "APPLY"/"SKIP"/"NO_JD" but a stray lowercase
    // or trailing space must never be misread. A strict === check previously fell through to
    // SKIP on any mismatch — the worst outcome (a wrongly-skipped job). If it's none of the three,
    // surface an error instead of guessing.
    const decision = String(v?.decision || "").trim().toUpperCase();
    if (decision === "NO_JD") {
      renderNoJD();
      return;
    }
    if (decision !== "APPLY" && decision !== "SKIP") {
      renderError("The AI returned an unexpected response. Please try again.");
      return;
    }
    const isApply = decision === "APPLY";
    const isLowConfidence = String(v?.confidence || "").trim().toLowerCase() === "low";
    const title = isApply ? "Apply" : "Skip";
    const stateClass = isApply ? "aon-apply-top" : "aon-fail-top";
    const dotClass = isApply ? "aon-dot-green" : "aon-dot-red";
    const reasonPrefix = isLowConfidence ? "Borderline — " : "";
    const reasonText = reasonPrefix + (v.reason || "");

    lastVerdictContext = { pageUrl: location.href, decision, reason: v.reason || "" };

    const detailSections = v.gaps?.length ? `<div class="aon-section-title">Gaps</div>${chips(v.gaps, "warn")}` : "";
    const modelLabel = v.model ? `<div class="aon-model-label">via ${escapeHtml(v.model)}</div>` : "";

    render(`<div class="aon-card ${isApply ? "aon-apply" : "aon-fail"}">
      ${headerBar(stateClass, title)}
      <div class="aon-verdict-row">
        <span class="aon-dot ${dotClass}"></span>
        <span class="aon-verdict-reason">${escapeHtml(reasonText)}</span>
      </div>
      ${
        detailSections
          ? `<button class="aon-details-toggle" data-aon-details>
               <span class="aon-details-label">Details</span>
               <svg class="aon-details-caret" viewBox="0 0 16 16" width="12" height="12"><path d="M4 6l4 4 4-4" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>
             </button>
             <div class="aon-details">${detailSections}</div>`
          : ""
      }
      ${modelLabel}
      ${footerHtml(true)}
    </div>`);
  }

  function wireFooterLinks(root) {
    const rate = root.querySelector("[data-aon-rate]");
    const rateSep = root.querySelector("[data-aon-rate-sep]");
    const feedback = root.querySelector("[data-aon-feedback]");
    const report = root.querySelector("[data-aon-report]");
    // The review URL 404s until the extension is actually published and assigned a real ID —
    // hide the link (and its separator, so Feedback doesn't show a dangling leading "·") rather
    // than pointing at a broken page.
    if (rate) {
      if (EXTENSION_ID) {
        rate.href = `https://chromewebstore.google.com/detail/${EXTENSION_ID}/reviews`;
      } else {
        rate.style.display = "none";
        if (rateSep) rateSep.style.display = "none";
      }
    }
    if (feedback) feedback.href = "mailto:ashrafahmed1232@gmail.com?subject=ApplyOrNot%20feedback";
    if (report) {
      const ctx = lastVerdictContext;
      const body = ctx
        ? `Page: ${ctx.pageUrl}\nVerdict: ${ctx.decision}\nReason: ${ctx.reason}\n\nWhat seems wrong:\n`
        : "";
      report.href = `mailto:ashrafahmed1232@gmail.com?subject=${encodeURIComponent("ApplyOrNot verdict report")}&body=${encodeURIComponent(body)}`;
    }
  }

  async function getProfile() {
    const { profile, preferences } = await chrome.storage.local.get(["profile", "preferences"]);
    // Default matches the popup's displayed default (0–1) so an untouched setup judges
    // against the same range the UI shows.
    return { profile, preferences: preferences || { targetMin: 0, targetMax: 1 } };
  }

  /** Called on load and on SPA navigation to a new listing. Makes no network call — only
   *  checks local storage for a profile, then shows either the empty state or the idle pill. */
  async function resetToIdle() {
    if (!overlayEnabled) return;
    // A new listing is a fresh start — clear any collapsed state left over from a previous
    // verdict card, otherwise render() would draw the idle pill in its collapsed (empty) form.
    collapsed = false;
    const { profile } = await getProfile();
    if (!profile) {
      renderNoProfile();
      return;
    }
    renderIdle();
  }

  /** Runs only when the user clicks "Check fit". */
  async function runVerdict() {
    if (running || !overlayEnabled) return;
    running = true;
    try {
      const { profile, preferences } = await getProfile();
      if (!profile) {
        renderNoProfile();
        return;
      }
      renderLoading();
      const { text: jdText, title: jdTitle, tier } = await ScraperLib.scrapeFullJD();
      if (tier === "none" || !jdText) {
        renderNoJD();
        return;
      }

      // Cache hit -> the AI's own prior verdict for this exact JD, 0 tokens.
      const cached = await CacheLib.getCachedVerdict(jdText);
      if (cached) {
        renderVerdict(cached.verdict);
        return;
      }

      const verdict = await LLMLib.getVerdict(profile, preferences, jdTitle, jdText);
      renderVerdict(verdict);
      // NO_JD isn't cached — the page may simply not have finished rendering the JD yet, and a
      // stale "no JD" shouldn't stick once real content loads (e.g. client-side-rendered listings).
      if (String(verdict?.decision || "").trim().toUpperCase() !== "NO_JD") {
        await CacheLib.setCachedVerdict(jdText, verdict);
      }
    } catch (err) {
      console.error("[ApplyOrNot] verdict error", err);
      renderError(err.message || "Something went wrong. Try again in a moment.");
    } finally {
      running = false;
    }
  }

  function checkAndRun() {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      setTimeout(resetToIdle, 600); // let the new JD render first; still no network call
    }
  }

  (async function init() {
    // resetToIdle() runs FIRST and independently — on some pages document.body isn't
    // ready yet even at document_idle (rare, but real: XML/plugin views, very fast
    // redirects). observe() throwing there must never also block the pill from showing.
    await loadOverlaySetting();
    resetToIdle(); // idle pill on first load — no network call until clicked
    try {
      new MutationObserver(checkAndRun).observe(document.body, { childList: true, subtree: true });
    } catch (err) {
      console.error("[ApplyOrNot] could not observe document.body for SPA navigation", err);
      document.addEventListener(
        "DOMContentLoaded",
        () => new MutationObserver(checkAndRun).observe(document.body, { childList: true, subtree: true }),
        { once: true }
      );
    }
  })();
})();

// Reads the FULL job description text from the page, fully automatically —
// the user never clicks "Read more". Two-tier strategy: precise Tier-1
// selectors for known sites (LinkedIn, Indeed, major ATS platforms), and a
// Readability-based Tier-2 fallback for any other career site.
(function (root) {
  let siteConfigCache = null;

  async function loadSiteConfig() {
    if (siteConfigCache) return siteConfigCache;
    const res = await fetch(chrome.runtime.getURL("data/site-selectors.json"));
    siteConfigCache = await res.json();
    return siteConfigCache;
  }

  function matchSite(config) {
    const host = location.host;
    for (const [key, site] of Object.entries(config.sites)) {
      if (site.hostIncludes.some((h) => host.includes(h))) return { key, ...site };
    }
    return null;
  }

  function isVisible(el) {
    if (!el) return false;
    const rect = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
  }

  /** Clicks known expand toggles (site-specific + generic text/aria heuristics) so truncated content renders. */
  async function autoExpand(site, genericPatterns) {
    const selectors = site?.expandButtons || [];
    let clicked = false;

    for (const sel of selectors) {
      document.querySelectorAll(sel).forEach((btn) => {
        if (isVisible(btn)) {
          btn.click();
          clicked = true;
        }
      });
    }

    // Generic fallback: any visible button/link whose text or aria-label matches a "read more" pattern.
    const candidates = document.querySelectorAll("button, a, span[role='button'], [aria-expanded]");
    candidates.forEach((el) => {
      const text = (el.textContent || "").trim().toLowerCase();
      const aria = (el.getAttribute("aria-label") || "").toLowerCase();
      const hit = genericPatterns.some((p) => text.includes(p) || aria.includes(p));
      if (hit && isVisible(el)) {
        el.click();
        clicked = true;
      }
    });

    if (clicked) {
      // Let the DOM update after the click before we scrape.
      await new Promise((r) => setTimeout(r, 400));
    }
    return clicked;
  }

  function readContainerText(site) {
    if (!site) return null;
    for (const sel of site.container) {
      const el = document.querySelector(sel);
      if (el && el.textContent && el.textContent.trim().length > 40) {
        // .textContent reads everything in the DOM regardless of CSS clipping/collapse —
        // this is what defeats the "read more" truncation bug seen in other tools.
        return el.textContent.replace(/\s+\n/g, "\n").trim();
      }
    }
    return null;
  }

  function readViaReadability() {
    try {
      const clone = document.cloneNode(true);
      const article = new Readability(clone).parse();
      if (article && article.textContent && article.textContent.trim().length > 100) {
        return article.textContent.trim();
      }
    } catch (e) {
      // Readability can throw on unusual DOM shapes; fall through to null.
    }
    return null;
  }

  /** Full pipeline: expand truncated content, then read the full JD text via Tier-1 or Tier-2. */
  async function scrapeFullJD() {
    const config = await loadSiteConfig();
    const site = matchSite(config);

    await autoExpand(site, config.genericExpandButtonPatterns);

    let text = readContainerText(site);
    let tier = "tier1";
    if (!text) {
      text = readViaReadability();
      tier = "tier2";
    }
    return { text: text || "", tier, site: site?.key || "unknown" };
  }

  root.ScraperLib = { scrapeFullJD, matchSite, loadSiteConfig };
})(typeof self !== "undefined" ? self : this);

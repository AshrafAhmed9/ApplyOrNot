// Reads the FULL job description text from the page, fully automatically —
// the user never clicks "Read more". Two-tier strategy: precise Tier-1
// selectors for known sites (LinkedIn, Indeed, major ATS platforms), and a
// Readability-based Tier-2 fallback for any other career site.
(function (root) {
  let siteConfigCache = null;

  // A real JD is a substantial block of text that actually reads like a job posting.
  // This gate exists so a wrong/empty container match (search pages, notifications,
  // a company page) renders as "no JD detected" instead of being scored as a bogus JD.
  const JD_MIN_LENGTH = 150;
  const JD_SIGNAL_RE = /\b(responsibilit|requirement|qualificat|experience|skills?|about the (role|job)|what you.?ll do|you will|you have|nice to have)\b/i;

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

  function isLikelyJD(text) {
    return !!text && text.length >= JD_MIN_LENGTH && JD_SIGNAL_RE.test(text);
  }

  const BLOCK_TAGS = new Set(["LI", "P", "BR", "DIV", "TR", "H1", "H2", "H3", "H4", "H5", "H6", "UL", "OL", "SECTION"]);

  /**
   * Reads text while preserving bullet/paragraph boundaries as newlines. Plain
   * `.textContent` concatenates every <li>/<p> with no separator, which collapses
   * a whole bulleted requirements list into one giant unbroken line — that in turn
   * makes the matcher treat the entire JD as a single requirement "unit", so the
   * match score can only ever land on 0% or 100% instead of a real percentage.
   */
  function extractBlockText(el) {
    let out = "";
    function walk(node) {
      if (node.nodeType === Node.TEXT_NODE) {
        out += node.textContent;
        return;
      }
      if (node.nodeType !== Node.ELEMENT_NODE) return;
      if (node.tagName === "BR") {
        out += "\n";
        return;
      }
      if (node.tagName === "SCRIPT" || node.tagName === "STYLE") return;
      // Guard against markup where adjacent elements have zero whitespace between them
      // (e.g. <li>Python</li><li>Java</li> with no text node in between) — without this,
      // sibling bullets can fuse into one run-on word/unit with no separator at all.
      if (out.length > 0 && !/\s$/.test(out)) out += " ";
      for (const child of node.childNodes) walk(child);
      if (BLOCK_TAGS.has(node.tagName)) out += "\n";
    }
    walk(el);
    return out;
  }

  /**
   * Clicks known expand toggles so truncated content renders — scoped tightly to avoid
   * ever triggering real page navigation:
   *  - site-specific selectors are searched within the JD container only (falls back to
   *    document-wide only if the container hasn't rendered yet).
   *  - the generic text/aria fallback NEVER matches <a> links (anchors navigate) and is
   *    scoped to the container element, never the whole document.
   */
  async function autoExpand(site, genericPatterns) {
    let clicked = false;
    const containerEl = site ? site.container.map((sel) => document.querySelector(sel)).find(Boolean) : null;
    const searchRoot = containerEl || document;

    for (const sel of site?.expandButtons || []) {
      searchRoot.querySelectorAll(sel).forEach((btn) => {
        if (isVisible(btn)) {
          btn.click();
          clicked = true;
        }
      });
    }

    // Generic fallback: only inside the known JD container, and never on <a> (anchors navigate).
    if (containerEl) {
      const candidates = containerEl.querySelectorAll("button, span[role='button'], [aria-expanded]:not(a)");
      candidates.forEach((el) => {
        if (el.tagName === "A") return; // extra guard: never click a real link
        const text = (el.textContent || "").trim().toLowerCase();
        const aria = (el.getAttribute("aria-label") || "").toLowerCase();
        const hit = genericPatterns.some((p) => text.includes(p) || aria.includes(p));
        if (hit && isVisible(el)) {
          el.click();
          clicked = true;
        }
      });
    }

    if (clicked) {
      // Let the DOM update after the click before we scrape.
      await new Promise((r) => setTimeout(r, 400));
    }
    return clicked;
  }

  function cleanBlockText(raw) {
    return raw
      .split("\n")
      .map((l) => l.replace(/[ \t]+/g, " ").trim())
      .filter((l) => l.length > 0)
      .join("\n");
  }

  function readContainerText(site) {
    if (!site) return null;
    for (const sel of site.container) {
      const el = document.querySelector(sel);
      if (el && el.textContent && el.textContent.trim().length > 40) {
        // Reading via block-aware extraction (not raw .textContent) is what defeats BOTH
        // the "read more" truncation bug (CSS-clipped content is still in the DOM) AND
        // flattened bullet lists (which would otherwise collapse into one giant line).
        return cleanBlockText(extractBlockText(el));
      }
    }
    return null;
  }

  function readViaReadability() {
    try {
      const clone = document.cloneNode(true);
      const article = new Readability(clone).parse();
      if (article && article.content && article.textContent && article.textContent.trim().length > 100) {
        const container = document.createElement("div");
        container.innerHTML = article.content;
        return cleanBlockText(extractBlockText(container));
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
    if (!isLikelyJD(text)) {
      const fallback = readViaReadability();
      if (isLikelyJD(fallback)) {
        text = fallback;
        tier = "tier2";
      } else {
        return { text: "", tier: "none", site: site?.key || "unknown" };
      }
    }
    return { text, tier, site: site?.key || "unknown" };
  }

  root.ScraperLib = { scrapeFullJD, matchSite, loadSiteConfig, isLikelyJD };
})(typeof self !== "undefined" ? self : this);

// Verdict cache: keyed by a hash of the cleaned JD text, so re-opening the same listing
// returns the AI's own prior verdict instantly with zero network calls/tokens. This can
// never produce a different or wrong result — it's the same verdict the AI already gave.
(function (root) {
  const MAX_CACHE_ENTRIES = 200;

  // Small, fast string hash (not cryptographic — just needs to key a cache).
  function hashText(text) {
    let h = 0;
    for (let i = 0; i < text.length; i++) {
      h = (Math.imul(31, h) + text.charCodeAt(i)) | 0;
    }
    return String(h);
  }

  async function getCachedVerdict(jdText) {
    const key = hashText(jdText);
    const { verdictCache } = await chrome.storage.local.get("verdictCache");
    return verdictCache?.[key] || null;
  }

  async function setCachedVerdict(jdText, verdict) {
    const key = hashText(jdText);
    const { verdictCache } = await chrome.storage.local.get("verdictCache");
    const cache = verdictCache || {};
    cache[key] = { verdict, timestamp: Date.now() };

    // Evict oldest entries beyond the cap so storage doesn't grow unbounded.
    const entries = Object.entries(cache);
    if (entries.length > MAX_CACHE_ENTRIES) {
      entries.sort((a, b) => a[1].timestamp - b[1].timestamp);
      const toDrop = entries.slice(0, entries.length - MAX_CACHE_ENTRIES);
      for (const [k] of toDrop) delete cache[k];
    }

    await chrome.storage.local.set({ verdictCache: cache });
  }

  const CacheLib = { getCachedVerdict, setCachedVerdict, hashText };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = CacheLib;
  } else {
    root.CacheLib = CacheLib;
  }
})(typeof self !== "undefined" ? self : this);

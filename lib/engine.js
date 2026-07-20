// Shared glue between chrome.storage, the offscreen embedder, and the pure
// MatcherLib/ExperienceLib logic. Used by both popup.js (resume upload) and
// content_script.js (JD scoring).
(function (root) {
  const DOMAIN_ANCHORS_URL = chrome.runtime.getURL("data/domain-anchors.json");
  const SOFT_SKILLS_URL = chrome.runtime.getURL("data/soft-skills.json");
  const SKILLS_DICTIONARY_URL = chrome.runtime.getURL("data/skills-dictionary.json");

  let softTermsCache = null;
  let domainAnchorsCache = null;
  let skillsRegexCache = null;

  async function loadJSON(url) {
    const res = await fetch(url);
    return res.json();
  }

  async function getSoftTerms() {
    if (!softTermsCache) softTermsCache = (await loadJSON(SOFT_SKILLS_URL)).terms;
    return softTermsCache;
  }

  async function getDomainAnchors() {
    if (!domainAnchorsCache) domainAnchorsCache = (await loadJSON(DOMAIN_ANCHORS_URL)).domains;
    return domainAnchorsCache;
  }

  /** Compiled skills-dictionary matcher, built once and reused for display-only keyword extraction. */
  async function getSkillsRegex() {
    if (!skillsRegexCache) {
      const terms = (await loadJSON(SKILLS_DICTIONARY_URL)).terms;
      skillsRegexCache = MatcherLib.buildSkillsMatcher(terms);
    }
    return skillsRegexCache;
  }

  /** Sends texts to the offscreen embedder via the service worker. Batches for speed. */
  async function embedTexts(texts) {
    if (!texts.length) return [];
    const res = await chrome.runtime.sendMessage({ type: "EMBED_REQUEST", texts });
    if (!res || !res.ok) throw new Error(res?.error || "Embedding failed");
    return res.vectors;
  }

  /** Domain anchor centroids, computed once and cached in storage (keyed by anchor-file version). */
  async function getDomainCentroids() {
    const anchors = await getDomainAnchors();
    const stamp = JSON.stringify(Object.keys(anchors).map((k) => [k, anchors[k].length]));
    const stored = await chrome.storage.local.get("domainCentroids");
    if (stored.domainCentroids && stored.domainCentroids.stamp === stamp) {
      return stored.domainCentroids.centroids;
    }

    const domainNames = Object.keys(anchors);
    const allSentences = [];
    const boundaries = [];
    for (const name of domainNames) {
      boundaries.push({ name, start: allSentences.length, count: anchors[name].length });
      allSentences.push(...anchors[name]);
    }
    const vectors = await embedTexts(allSentences);
    const centroids = {};
    for (const b of boundaries) {
      const slice = vectors.slice(b.start, b.start + b.count);
      centroids[b.name] = MatcherLib.meanVector(slice);
    }
    await chrome.storage.local.set({ domainCentroids: { stamp, centroids } });
    return centroids;
  }

  /**
   * Processes a freshly-parsed resume at upload time: splits into units,
   * embeds them, and classifies the resume's domain(s).
   * rawText: full extracted resume text.
   * Returns { units: [{text, vec}], domains: string[] }
   */
  async function processResumeText(rawText) {
    const softTerms = await getSoftTerms();
    const units = MatcherLib.splitIntoUnits(rawText).filter((u) => u.length > 4);
    const vectors = await embedTexts(units);
    const unitObjs = units.map((text, i) => ({ text, vec: vectors[i] }));
    const centroids = await getDomainCentroids();
    // Soft-skill-heavy bullets ("strong communication and leadership") read semantically
    // closer to HR/people-skills content and would otherwise skew domain classification
    // away from the resume's real field — exclude them from the domain vector specifically.
    const domainUnits = unitObjs.filter((u) => !MatcherLib.containsSoftTermMention(u.text, softTerms));
    const domainVector = MatcherLib.meanVector((domainUnits.length ? domainUnits : unitObjs).map((u) => u.vec));
    const classification = MatcherLib.classifyDomain(domainVector, centroids);
    return { units: unitObjs, domains: classification.domains, primaryDomain: classification.primary };
  }

  /**
   * Scores a scraped JD against every stored resume and returns the best fit.
   * resumes: array of stored resume records ({domains, units, targetMin, targetMax, label, id})
   * jdText: full scraped JD text.
   */
  async function scoreJD(jdText, resumes) {
    const softTerms = await getSoftTerms();
    const domainCentroids = await getDomainCentroids();
    const skillsRegex = await getSkillsRegex();
    const { required, preferred } = MatcherLib.parseJDRequirements(jdText, softTerms);

    const uniqueTexts = Array.from(new Set([...required, ...preferred]));
    const vectors = uniqueTexts.length ? await embedTexts(uniqueTexts) : [];
    const vecByText = new Map(uniqueTexts.map((t, i) => [t, vectors[i]]));

    const jdUnitVectors = [
      ...required.map((text) => ({ text, vec: vecByText.get(text), section: "required" })),
      ...preferred.map((text) => ({ text, vec: vecByText.get(text), section: "preferred" })),
    ];

    // Same reasoning as processResumeText: soft-skill-heavy bullets are excluded from the
    // domain-classification vector so they can't drag a technical JD toward an HR/people
    // reading — they're still scored as (weak) requirements above, just not used for this.
    const domainUnits = jdUnitVectors.filter((u) => !MatcherLib.containsSoftTermMention(u.text, softTerms));
    const domainVectorSource = domainUnits.length ? domainUnits : jdUnitVectors;
    const jdVector = domainVectorSource.length
      ? MatcherLib.meanVector(domainVectorSource.map((u) => u.vec))
      : (await embedTexts([jdText.slice(0, 1000)]))[0];

    const jd = { text: jdText };
    const verdictFn = (resume) =>
      MatcherLib.getVerdict({ resume, jd, jdVector, jdUnitVectors, domainCentroids, softTerms, skillsRegex });

    return MatcherLib.pickBestResume(resumes, verdictFn);
  }

  const EngineLib = {
    getSoftTerms,
    getDomainAnchors,
    getDomainCentroids,
    getSkillsRegex,
    embedTexts,
    processResumeText,
    scoreJD,
  };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = EngineLib;
  } else {
    root.EngineLib = EngineLib;
  }
})(typeof self !== "undefined" ? self : this);

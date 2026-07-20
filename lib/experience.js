// Deterministic (regex-only, no embeddings) experience-requirement parsing.
// Kept separate from the semantic matcher because exact-number logic needs
// precision, not paraphrase understanding.
(function (root) {
  const YEAR_UNIT = "(?:years?|yrs?)";
  const NUM = "(\\d+(?:\\.\\d+)?)";

  // Words within this many characters BEFORE a match that indicate a hard requirement.
  const HARD_CONTEXT = /(required|requires?|must have|minimum|min\.?|at least|need(?:s|ed)?)\b[^.]{0,25}$/i;
  // Words within this many characters BEFORE/AFTER a match that indicate a soft/preferred flag.
  const SOFT_CONTEXT = /(preferred|nice to have|a plus|is a plus|bonus|advantage|desirable|good to have)/i;
  // A year-mention near this kind of language is almost always describing the COMPANY
  // ("20 years of combined experience serving clients"), not a candidate requirement —
  // these are extremely common in JD boilerplate/about-us copy and must never gate.
  const COMPANY_CONTEXT = /\b(company|industry|clients?|customers?|combined|since \d{4}|founded|established|history|legacy|serving|market leader|reputation|business)\b/i;

  const SENIOR_WORDS = /\b(senior|sr\.?|staff|principal|lead|architect|manager|head of)\b/i;
  const JUNIOR_WORDS = /\b(junior|jr\.?|entry[- ]level|entry level|graduate|new grad|fresher|intern(?:ship)?|associate)\b/i;

  function contextWindow(text, start, end, span = 60) {
    return {
      before: text.slice(Math.max(0, start - span), start),
      after: text.slice(end, Math.min(text.length, end + span)),
    };
  }

  function isCompanyContext(text, start, end) {
    const { before, after } = contextWindow(text, start, end, 45);
    return COMPANY_CONTEXT.test(before) || COMPANY_CONTEXT.test(after);
  }

  function classifyConfidence(text, start, end) {
    const { before, after } = contextWindow(text, start, end);
    if (SOFT_CONTEXT.test(before) || SOFT_CONTEXT.test(after)) return "soft";
    if (HARD_CONTEXT.test(before)) return "hard";
    // "3+ years of experience with X" with no explicit qualifier either way still
    // defaults to hard — most real JDs state a real requirement this way without ever
    // literally writing "required". (Company-history mentions like "20 years serving
    // clients" are excluded entirely upstream via isCompanyContext, not handled here.)
    return "hard";
  }

  /**
   * Finds every "N years" style requirement in text.
   * Returns an array of { min, max, confidence: 'hard'|'soft', raw, index } sorted by
   * position, with overlapping matches from different patterns deduplicated (keeping
   * the longest/most complete span) and company-history mentions dropped entirely.
   * Numbers not immediately adjacent to a year unit are ignored, which is what keeps
   * this from matching "2024", "401k", "Python 3", etc.
   */
  function findExperienceMentions(text) {
    const raw = [];

    // Range: "2-4 years", "2 to 4 yrs", "2–4 years", "1-2 +years"
    const rangeRe = new RegExp(`${NUM}\\s*(?:-|–|—|to)\\s*${NUM}\\s*\\+?\\s*${YEAR_UNIT}`, "gi");
    let m;
    while ((m = rangeRe.exec(text))) {
      raw.push({ min: parseFloat(m[1]), max: parseFloat(m[2]), raw: m[0], index: m.index });
    }

    // Floor with explicit plus: "3+ years", "3 plus years"
    const plusRe = new RegExp(`${NUM}\\s*(?:\\+|plus)\\s*${YEAR_UNIT}`, "gi");
    while ((m = plusRe.exec(text))) {
      raw.push({ min: parseFloat(m[1]), max: Infinity, raw: m[0], index: m.index });
    }

    // Floor with keyword: "minimum 3 years", "at least 3 years", "min. 3 yrs"
    const floorKeywordRe = new RegExp(`(?:minimum|min\\.?|at least)\\s*(?:of\\s*)?${NUM}\\s*${YEAR_UNIT}`, "gi");
    while ((m = floorKeywordRe.exec(text))) {
      raw.push({ min: parseFloat(m[1]), max: Infinity, raw: m[0], index: m.index, forceHard: true });
    }

    // Single value: "3 years of experience", "3 years experience", "3 yrs in ..."
    const singleRe = new RegExp(`${NUM}\\s*${YEAR_UNIT}\\b(?:\\s*(?:of\\s*)?experience)?`, "gi");
    while ((m = singleRe.exec(text))) {
      const val = parseFloat(m[1]);
      raw.push({ min: val, max: val, raw: m[0], index: m.index });
    }

    // Dedup overlapping matches from different patterns (e.g. "1-2 +years" is caught
    // whole by rangeRe AND partially by plusRe as "2 +years") — keep the match that
    // starts earliest and, among those tied, the longest/most complete span.
    raw.sort((a, b) => a.index - b.index || b.raw.length - a.raw.length);
    const deduped = [];
    for (const r of raw) {
      const overlaps = deduped.some(
        (d) => r.index < d.index + d.raw.length && d.index < r.index + r.raw.length
      );
      if (!overlaps) deduped.push(r);
    }

    return deduped
      .filter((r) => !isCompanyContext(text, r.index, r.index + r.raw.length))
      .map((r) => ({
        ...r,
        confidence: r.forceHard ? "hard" : classifyConfidence(text, r.index, r.index + r.raw.length),
      }))
      .sort((a, b) => a.index - b.index);
  }

  /** Highest-confidence, most-stringent requirement found (hard mentions win over soft). */
  function extractExperienceYears(text) {
    const mentions = findExperienceMentions(text);
    if (mentions.length === 0) return null;
    const hard = mentions.filter((m) => m.confidence === "hard");
    const pool = hard.length > 0 ? hard : mentions;
    // Most stringent = highest minimum (the JD's real floor).
    return pool.reduce((best, m) => (m.min > best.min ? m : best), pool[0]);
  }

  /** Soft (non-blocking) mentions, e.g. "3 years preferred", surfaced as a note only. */
  function extractSoftExperienceNote(text) {
    const mentions = findExperienceMentions(text).filter((m) => m.confidence === "soft");
    return mentions.length ? mentions[0] : null;
  }

  function detectSeniorityKeywords(text) {
    const senior = SENIOR_WORDS.test(text);
    const junior = JUNIOR_WORDS.test(text);
    if (senior && !junior) return "senior";
    if (junior && !senior) return "junior";
    return null; // both or neither present -> ambiguous, treat as no signal
  }

  /**
   * targetMin/targetMax: the user's target experience range from the upload slider.
   * Returns { status: 'FAIL'|'PASS'|'OVERQUALIFIED'|'UNKNOWN', label, req? }
   */
  function getExperienceVerdict(jdText, targetMin, targetMax) {
    const req = extractExperienceYears(jdText);

    if (req !== null && req.confidence === "hard") {
      if (req.min > targetMax) {
        return {
          status: "FAIL",
          label: `Requires ${formatYears(req)}+ yrs — above your ${targetMin}-${targetMax} yr target`,
          req,
        };
      }
      if (req.max < targetMin) {
        return {
          status: "OVERQUALIFIED",
          label: `Entry-level (${formatYears(req)} yrs) — your experience exceeds this JD`,
          req,
        };
      }
      return { status: "PASS", label: `${formatYears(req)} yrs — in your target range`, req };
    }

    // Only a soft mention ("3 years preferred") — never blocks, always PASS/neutral.
    if (req !== null && req.confidence === "soft") {
      const seniorityNote = detectSeniorityKeywords(jdText);
      const softLabel = `${formatYears(req)} yrs preferred (not required)`;
      if (seniorityNote === "junior" && targetMin > 1) {
        return { status: "OVERQUALIFIED", label: `Entry-level role — ${softLabel}`, req };
      }
      return { status: "PASS", label: softLabel, req };
    }

    const flag = detectSeniorityKeywords(jdText);
    if (flag === "senior") {
      return targetMax < 3
        ? { status: "FAIL", label: "Senior role (no years stated) — above your target" }
        : { status: "PASS", label: "Senior role — matches your target" };
    }
    if (flag === "junior") {
      return targetMin > 1
        ? { status: "OVERQUALIFIED", label: "Entry-level role — your experience exceeds this" }
        : { status: "PASS", label: "Entry-level — in your target range" };
    }

    return { status: "UNKNOWN", label: "Experience not specified — check manually" };
  }

  function formatYears(req) {
    if (!isFinite(req.max) || req.max === req.min) return `${req.min}`;
    return `${req.min}-${req.max}`;
  }

  const ExperienceLib = {
    extractExperienceYears,
    findExperienceMentions,
    extractSoftExperienceNote,
    detectSeniorityKeywords,
    getExperienceVerdict,
  };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = ExperienceLib;
  } else {
    root.ExperienceLib = ExperienceLib;
  }
})(typeof self !== "undefined" ? self : this);

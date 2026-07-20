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

  const SENIOR_WORDS = /\b(senior|sr\.?|staff|principal|lead|architect|manager|head of)\b/i;
  const JUNIOR_WORDS = /\b(junior|jr\.?|entry[- ]level|entry level|graduate|new grad|fresher|intern(?:ship)?|associate)\b/i;

  function contextWindow(text, start, end) {
    return {
      before: text.slice(Math.max(0, start - 60), start),
      after: text.slice(end, Math.min(text.length, end + 30)),
    };
  }

  function classifyConfidence(text, start, end) {
    const { before, after } = contextWindow(text, start, end);
    if (SOFT_CONTEXT.test(before) || SOFT_CONTEXT.test(after)) return "soft";
    if (HARD_CONTEXT.test(before)) return "hard";
    // "3+ years" / "3-5 years of experience" with no explicit softener defaults to hard —
    // conservative: unqualified numeric requirements are treated as real gates.
    return "hard";
  }

  /**
   * Finds every "N years" style requirement in text.
   * Returns an array of { min, max, confidence: 'hard'|'soft', raw } sorted by
   * position. Numbers not immediately adjacent to a year unit are ignored,
   * which is what keeps this from matching "2024", "401k", "Python 3", etc.
   */
  function findExperienceMentions(text) {
    const results = [];

    // Range: "2-4 years", "2 to 4 yrs", "2–4 years"
    const rangeRe = new RegExp(`${NUM}\\s*(?:-|–|—|to)\\s*${NUM}\\s*\\+?\\s*${YEAR_UNIT}`, "gi");
    let m;
    while ((m = rangeRe.exec(text))) {
      results.push({
        min: parseFloat(m[1]),
        max: parseFloat(m[2]),
        confidence: classifyConfidence(text, m.index, m.index + m[0].length),
        raw: m[0],
        index: m.index,
      });
    }

    // Floor with explicit plus: "3+ years", "3 plus years"
    const plusRe = new RegExp(`${NUM}\\s*(?:\\+|plus)\\s*${YEAR_UNIT}`, "gi");
    while ((m = plusRe.exec(text))) {
      results.push({
        min: parseFloat(m[1]),
        max: Infinity,
        confidence: classifyConfidence(text, m.index, m.index + m[0].length),
        raw: m[0],
        index: m.index,
      });
    }

    // Floor with keyword: "minimum 3 years", "at least 3 years", "min. 3 yrs"
    const floorKeywordRe = new RegExp(`(?:minimum|min\\.?|at least)\\s*(?:of\\s*)?${NUM}\\s*${YEAR_UNIT}`, "gi");
    while ((m = floorKeywordRe.exec(text))) {
      results.push({
        min: parseFloat(m[1]),
        max: Infinity,
        confidence: "hard", // "minimum/at least" is explicitly a hard floor by definition
        raw: m[0],
        index: m.index,
      });
    }

    // Single value: "3 years of experience", "3 years experience", "3 yrs in ..."
    const singleRe = new RegExp(`${NUM}\\s*${YEAR_UNIT}\\b(?:\\s*(?:of\\s*)?experience)?`, "gi");
    while ((m = singleRe.exec(text))) {
      // Skip if this position was already captured by a more specific pattern above.
      const overlaps = results.some((r) => m.index >= r.index && m.index < r.index + r.raw.length + 5);
      if (overlaps) continue;
      const val = parseFloat(m[1]);
      results.push({
        min: val,
        max: val,
        confidence: classifyConfidence(text, m.index, m.index + m[0].length),
        raw: m[0],
        index: m.index,
      });
    }

    return results.sort((a, b) => a.index - b.index);
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

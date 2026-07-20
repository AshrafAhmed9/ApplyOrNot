// Pure orchestration logic: domain gate + semantic skill coverage + feedback.
// No DOM/chrome dependencies so it can run in the test harness with a fake
// embedder, or in the extension with the real offscreen-backed one.
(function (root) {
  const ExperienceLib =
    typeof module !== "undefined" && module.exports ? require("./experience.js") : root.ExperienceLib;

  const COVER_THRESHOLD = 0.55; // cosine similarity above which a JD requirement counts as "covered"
  const APPLY_CUTOFF = 0.5; // weighted required-skill coverage below which verdict flips to DON'T APPLY ("balanced" strictness: ~50% of required skills)
  const DOMAIN_SIM_THRESHOLD = 0.42; // JD must be at least this close to a domain anchor to classify it at all
  const DOMAIN_MARGIN = 0.06; // and beat the runner-up domain by at least this much to hard-block on field

  const REQUIRED_HEADING_RE = /(requirements?|must[- ]have|what you('| )ll need|qualifications|responsibilities)\s*:?/i;
  const PREFERRED_HEADING_RE = /(nice[- ]to[- ]have|preferred|bonus|a plus|good to have)\s*:?/i;
  // Section headings whose CONTENT is company/role narrative, never actual requirements —
  // e.g. "About the job" followed by "We are looking for a passionate developer...".
  const SKIP_HEADING_RE = /(about (the )?(job|role|company|us|team)|who we are|our mission|company overview|why (join|work at|work with) us|benefits?|perks?|compensation|equal opportunity)\s*:?$/i;
  // Narrative filler sentences that show up as body text (not under any heading) and are
  // never themselves a skill/requirement to match against a resume.
  const FLUFF_LINE_RE = /^(about (the )?(job|role|company|us|team)|who we are|we('| a)re (looking for|seeking|hiring)|join our team|as a member of|you('ll| will) have the opportunity|if you('re| are) passionate)\b/i;

  function normalize(vec) {
    let norm = 0;
    for (const v of vec) norm += v * v;
    norm = Math.sqrt(norm) || 1;
    return vec.map((v) => v / norm);
  }

  function meanVector(vectors) {
    if (!vectors.length) return null;
    const dim = vectors[0].length;
    const sum = new Array(dim).fill(0);
    for (const v of vectors) for (let i = 0; i < dim; i++) sum[i] += v[i];
    return normalize(sum.map((s) => s / vectors.length));
  }

  function cosineSim(a, b) {
    let dot = 0, na = 0, nb = 0;
    for (let i = 0; i < a.length; i++) {
      dot += a[i] * b[i];
      na += a[i] * a[i];
      nb += b[i] * b[i];
    }
    if (na === 0 || nb === 0) return 0;
    return dot / (Math.sqrt(na) * Math.sqrt(nb));
  }

  /**
   * Splits resume/JD text into short semantic units: bullets, then sentences,
   * then (as a backstop) comma/semicolon-separated clauses. This matters for
   * scoring granularity — if a whole JD collapses into one giant unit, the
   * match score can only ever be 0% or 100% instead of a graduated percentage.
   */
  function splitIntoUnits(text) {
    const lines = text
      .split(/\r?\n/)
      .map((l) => l.replace(/^[\s•▪●·\-*]+/, "").trim())
      .filter((l) => l.length > 0);
    let units = [];
    for (const line of lines) {
      if (line.length > 200) {
        const sentences = line.split(/(?<=[.!?])\s+/).map((s) => s.trim()).filter((s) => s.length > 3);
        units.push(...sentences);
      } else {
        units.push(line);
      }
    }
    // Backstop: a unit with no sentence punctuation but several comma/semicolon-separated
    // items is likely a flattened bullet/skill list (block boundaries lost upstream) —
    // split it further so scoring isn't reduced to one giant all-or-nothing unit.
    const final = [];
    for (const u of units) {
      const parts = u.split(/\s*[,;]\s*/).filter((s) => s.length > 1);
      if (!/[.!?]/.test(u) && parts.length >= 3) {
        final.push(...parts.map((s) => s.trim()));
      } else {
        final.push(u);
      }
    }
    return final.filter((u) => u.length > 2 && u.length < 400);
  }

  function isSoftOnlyUnit(unit, softTerms) {
    let stripped = unit.toLowerCase();
    for (const term of softTerms) {
      stripped = stripped.split(term.toLowerCase()).join(" ");
    }
    stripped = stripped.replace(
      /\b(and|or|with|strong|excellent|good|great|solid|skills?|ability|abilities|to|a|an|the|of|in|is|are|being|as|well)\b/gi,
      " "
    );
    const remaining = stripped.replace(/[^a-z0-9]+/gi, " ").trim();
    const words = remaining.split(/\s+/).filter(Boolean);
    return words.length < 2;
  }

  /**
   * Splits JD text into required vs preferred requirement units, dropping soft-skill-only
   * asks AND narrative/company content (section intros like "About the job", or filler
   * sentences like "We are looking for a passionate developer..."). Without this, JD
   * boilerplate gets scored as if it were a skill to match against the resume — it never
   * matches anything, so it silently drags every JD's score down and shows up verbatim
   * in the "missing requirements" list.
   */
  function parseJDRequirements(jdText, softTerms) {
    const lines = jdText.split(/\r?\n/);
    let section = "required"; // default: unlabeled JDs are treated conservatively as all-required
    const required = [];
    const preferred = [];

    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line) continue;
      if (line.length < 60) {
        if (REQUIRED_HEADING_RE.test(line)) { section = "required"; continue; }
        if (PREFERRED_HEADING_RE.test(line)) { section = "preferred"; continue; }
        if (SKIP_HEADING_RE.test(line)) { section = "skip"; continue; }
      }
      if (section === "skip") continue;

      for (const unit of splitIntoUnits(line)) {
        if (isSoftOnlyUnit(unit, softTerms)) continue;
        if (FLUFF_LINE_RE.test(unit)) continue;
        (section === "required" ? required : preferred).push(unit);
      }
    }
    return { required, preferred };
  }

  function extractSoftSkillsFound(jdText, softTerms) {
    const lower = jdText.toLowerCase();
    return softTerms.filter((t) => lower.includes(t.toLowerCase()));
  }

  /**
   * Classifies a text against domain anchor centroids.
   * domainCentroids: { domainName: vector }
   * Returns { primary, domains: [names within 60% of top score], topScore, margin }
   */
  function classifyDomain(vector, domainCentroids) {
    const scores = Object.entries(domainCentroids).map(([name, centroid]) => [name, cosineSim(vector, centroid)]);
    scores.sort((a, b) => b[1] - a[1]);
    const [topName, topScore] = scores[0];
    const runnerUpScore = scores.length > 1 ? scores[1][1] : 0;
    const domains = scores.filter(([, s]) => s >= topScore * 0.85 || topScore - s < 0.03).map(([n]) => n);
    return { primary: topName, domains, topScore, margin: topScore - runnerUpScore };
  }

  function domainsOverlap(a, b) {
    return a.some((d) => b.includes(d));
  }

  /**
   * Core verdict pipeline.
   * resume: { domains: string[], units: [{text, vec}], targetMin, targetMax, label }
   * jd: { text: string }
   * jdVector: precomputed centroid embedding of the jd text (for domain classification)
   * jdUnitVectors: [{text, vec, section:'required'|'preferred'}] precomputed embeddings of parsed JD requirement units
   * domainCentroids: precomputed per-domain anchor centroids
   * softTerms: array of soft-skill phrases
   */
  function getVerdict({ resume, jd, jdVector, jdUnitVectors, domainCentroids, softTerms }) {
    const exp = ExperienceLib.getExperienceVerdict(jd.text, resume.targetMin, resume.targetMax);
    if (exp.status === "FAIL") {
      return { verdict: "DON'T APPLY", gate: "experience", reason: exp.label, expLabel: exp.label };
    }

    const jdDomain = classifyDomain(jdVector, domainCentroids);
    const confidentMismatch =
      jdDomain.topScore >= DOMAIN_SIM_THRESHOLD &&
      jdDomain.margin >= DOMAIN_MARGIN &&
      !domainsOverlap(resume.domains, jdDomain.domains);

    if (confidentMismatch) {
      return {
        verdict: "DON'T APPLY",
        gate: "domain",
        reason: `Different field — this JD is ${jdDomain.primary.replace(/_/g, " ")}, your resume is ${resume.domains[0].replace(/_/g, " ")}`,
        expLabel: exp.label,
      };
    }

    const required = jdUnitVectors.filter((u) => u.section === "required");
    const preferred = jdUnitVectors.filter((u) => u.section === "preferred");

    function scoreUnits(units) {
      return units.map((u) => {
        let best = 0;
        for (const ru of resume.units) {
          const sim = cosineSim(u.vec, ru.vec);
          if (sim > best) best = sim;
        }
        return { text: u.text, covered: best >= COVER_THRESHOLD, sim: best };
      });
    }

    const reqScored = scoreUnits(required);
    const prefScored = scoreUnits(preferred);

    const reqCovered = reqScored.filter((r) => r.covered).length;
    const prefCovered = prefScored.filter((r) => r.covered).length;
    const numerator = reqCovered * 1.0 + prefCovered * 0.3;
    const denominator = required.length * 1.0 + preferred.length * 0.3;
    const score = denominator > 0 ? numerator / denominator : 1;

    const reqGaps = reqScored.filter((r) => !r.covered).map((r) => r.text);
    const prefGaps = prefScored.filter((r) => !r.covered).map((r) => r.text);
    const strengths = reqScored.filter((r) => r.covered).map((r) => r.text);
    const softSkillsFound = extractSoftSkillsFound(jd.text, softTerms);

    const shortLabel = (s) => (s.length > 60 ? s.slice(0, 59).trimEnd() + "…" : s);

    if (score < APPLY_CUTOFF) {
      return {
        verdict: "DON'T APPLY",
        gate: "skills",
        reason: `Missing core requirements: ${reqGaps.slice(0, 3).map(shortLabel).join(", ")}`,
        matchPct: Math.round(score * 100),
        gaps: reqGaps,
        niceToHaveGaps: prefGaps,
        strengths,
        softSkillsFound,
        expLabel: exp.label,
      };
    }

    return {
      verdict: "APPLY",
      matchPct: Math.round(score * 100),
      gaps: reqGaps,
      niceToHaveGaps: prefGaps,
      strengths,
      softSkillsFound,
      expLabel: exp.label,
      note: exp.status === "OVERQUALIFIED" ? exp.label : null,
    };
  }

  /** Runs getVerdict against every resume and returns the best passing one (or the least-bad DON'T APPLY). */
  function pickBestResume(resumes, verdictFn) {
    const results = resumes.map((r) => ({ resume: r, verdict: verdictFn(r) }));
    const applies = results.filter((r) => r.verdict.verdict === "APPLY");
    const pool = applies.length ? applies : results;
    pool.sort((a, b) => (b.verdict.matchPct || 0) - (a.verdict.matchPct || 0));
    return { best: pool[0], all: results };
  }

  const MatcherLib = {
    COVER_THRESHOLD,
    APPLY_CUTOFF,
    DOMAIN_SIM_THRESHOLD,
    DOMAIN_MARGIN,
    cosineSim,
    normalize,
    meanVector,
    splitIntoUnits,
    isSoftOnlyUnit,
    parseJDRequirements,
    extractSoftSkillsFound,
    classifyDomain,
    domainsOverlap,
    getVerdict,
    pickBestResume,
  };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = MatcherLib;
  } else {
    root.MatcherLib = MatcherLib;
  }
})(typeof self !== "undefined" ? self : this);

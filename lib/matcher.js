// Pure orchestration logic: domain gate + semantic skill coverage + feedback.
// No DOM/chrome dependencies so it can run in the test harness with a fake
// embedder, or in the extension with the real offscreen-backed one.
(function (root) {
  const ExperienceLib =
    typeof module !== "undefined" && module.exports ? require("./experience.js") : root.ExperienceLib;

  const COVER_THRESHOLD = 0.55; // cosine similarity above which a JD requirement counts as "covered"
  const APPLY_CUTOFF = 0.5; // weighted required-skill coverage below which verdict flips to DON'T APPLY ("balanced" strictness: ~50% of required skills)
  const DOMAIN_SIM_THRESHOLD = 0.45; // JD must be at least this close to a domain anchor to classify it at all
  const DOMAIN_MARGIN = 0.1; // and beat the runner-up domain by at least this much to hard-block on field —
  // kept deliberately conservative: a false "different field" block silently tells someone
  // to skip a job they should apply to, which is worse than an occasional missed block.

  // Real JDs use huge heading variety ("What You'll Do", "What You Bring", "The Role",
  // "Qualifications", "Requirements", "Skills & Experience", ...) — this list can never be
  // exhaustive, so it's backstopped by looksLikeHeading() below, which treats ANY short,
  // punctuation-free, title/upper-cased line as a heading and defaults it into "required"
  // rather than getting stuck in whatever section came before.
  const REQUIRED_HEADING_RE = /(requirements?|must[- ]have|what you('| )ll (need|do|bring)|qualifications|responsibilities|what you bring|the role|skills? (and|&) experience|your (experience|profile)|who you are)\s*:?/i;
  const PREFERRED_HEADING_RE = /(nice[- ]to[- ]have|preferred|bonus|a plus|good to have)\s*:?/i;
  // Section headings whose CONTENT is company/role narrative, never actual requirements —
  // e.g. "About the job" followed by "We are looking for a passionate developer...".
  const SKIP_HEADING_RE = /(about (the )?(job|role|company|us|team)|who we are|our mission|company overview|why (join|work at|work with) us|benefits?|perks?|compensation|equal opportunity|what (you can expect|we offer|to expect)|commitment to|inclusive team|diversity|accommodations?)/i;

  /**
   * A short, comma/period-free, near-fully-capitalized, few-word line is almost certainly
   * a section heading — used as a fallback for the endless heading variety real JDs use
   * (see REQUIRED_HEADING_RE). Deliberately strict: a real requirement bullet like
   * "Experience with Python, SQL, and Airflow" is also short and multi-capitalized, so
   * this must never fire on it — hence excluding ANY internal comma/period (real bullets
   * almost always list multiple items or end a sentence; true headings do neither), capping
   * word count low, and requiring near-total capitalization rather than a loose majority.
   */
  function looksLikeHeading(line) {
    if (line.length >= 45 || line.length === 0) return false;
    if (/[.!?,;]/.test(line)) return false; // any internal punctuation, not just trailing
    const words = line.split(/\s+/).filter(Boolean);
    if (!words.length || words.length > 6) return false;
    if (line === line.toUpperCase() && /[A-Z]/.test(line)) return true;
    const capitalized = words.filter((w) => /^[A-Z]/.test(w)).length;
    return capitalized / words.length >= 0.8;
  }
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
  /**
   * Merges hard-wrapped continuation lines back into one logical line. Some JD sources
   * (PDF exports, certain career-page renderers) insert a line break — even a blank line —
   * mid-sentence at a fixed wrap width, so one real bullet like "Design and implement the
   * FSM: startup, steady-state, and fault states, with well-defined transitions and
   * interlocks." arrives as three separate lines. A continuation line never starts with a
   * bullet marker, and the line it continues never ends in sentence-final punctuation —
   * that's the signal used to reassemble it. Exported so parseJDRequirements can apply it
   * across the WHOLE JD before doing its own line-by-line heading detection.
   */
  function mergeContinuationLines(rawLines) {
    const lines = [];
    // Only merge wrap-continuations while inside an item that began with an EXPLICIT
    // bullet marker. Without this, an unmarked plain list where each line is genuinely
    // its own separate item (no bullets at all) would get wrongly glued together just
    // because a line doesn't end in terminal punctuation — very common for JD bullets.
    let continuingFromBullet = false;
    for (const raw of rawLines) {
      const hasBulletMarker = /^[•▪●·\-*]/.test(raw) || /^\d+[.)]\s/.test(raw);
      const clean = raw.replace(/^[\s•▪●·\-*]+/, "").replace(/^\d+[.)]\s*/, "").trim();
      const prev = lines[lines.length - 1];

      if (hasBulletMarker) {
        lines.push(clean);
        continuingFromBullet = !/[.!?:]$/.test(clean);
        continue;
      }
      if (continuingFromBullet && prev !== undefined) {
        lines[lines.length - 1] = `${prev} ${clean}`;
        continuingFromBullet = !/[.!?:]$/.test(lines[lines.length - 1]);
      } else {
        lines.push(clean);
        continuingFromBullet = false;
      }
    }
    return lines;
  }

  function splitIntoUnits(text) {
    const rawLines = text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 0);
    const lines = mergeContinuationLines(rawLines);

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
    const afterCommaSplit = [];
    for (const u of units) {
      const parts = u.split(/\s*[,;]\s*/).filter((s) => s.length > 1);
      if (!/[.!?]/.test(u) && parts.length >= 3) {
        afterCommaSplit.push(...parts.map((s) => s.trim()));
      } else {
        afterCommaSplit.push(u);
      }
    }

    // Absolute last resort: chop any unit that survived everything above and is still
    // too long, at word boundaries. This must never just DROP an oversized unit — an
    // empty required-units list makes getVerdict's score formula default to 100% (nothing
    // to fail), which is exactly how a total splitting failure upstream silently turns into
    // a false "perfect match" instead of a real error.
    const HARD_CAP = 260;
    const final = [];
    for (const u of afterCommaSplit) {
      if (u.length <= HARD_CAP) {
        final.push(u);
        continue;
      }
      const words = u.split(/\s+/);
      let chunk = "";
      for (const w of words) {
        if ((chunk + " " + w).trim().length > HARD_CAP && chunk) {
          final.push(chunk.trim());
          chunk = w;
        } else {
          chunk = (chunk ? chunk + " " : "") + w;
        }
      }
      if (chunk) final.push(chunk.trim());
    }

    return final.filter((u) => u.length > 2);
  }

  function isSoftOnlyUnit(unit, softTerms) {
    const lower = unit.toLowerCase();
    // No soft-skill phrase present at all -> never soft-only, regardless of length. Without
    // this early check, a standalone hard skill like "SQL" or "Docker" (nothing to strip,
    // 1 word remaining) was being misclassified as soft-only and silently dropped.
    if (!softTerms.some((t) => lower.includes(t.toLowerCase()))) return false;

    let stripped = lower;
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

  /** True if a unit mentions ANY soft-skill phrase at all, even alongside real content.
   *  Used to keep soft-skill-heavy bullets ("strong interpersonal skills...") out of the
   *  JD's domain-classification vector — a JD full of such phrasing reads semantically
   *  closer to HR/people-skills content and can otherwise drag domain classification off
   *  a technical field entirely, even though the bullet is still worth scoring as a
   *  (weak) requirement. */
  function containsSoftTermMention(unit, softTerms) {
    const lower = unit.toLowerCase();
    return softTerms.some((t) => lower.includes(t.toLowerCase()));
  }

  // Generic structural/narrative words that are capitalized but are never themselves a
  // skill — company names, section-label leftovers, pronouns, etc. Without this blocklist,
  // capitalization-based extraction mistakes "Role", "Details", or a company name for a
  // real requirement.
  const GENERIC_CAP_WORDS = new Set([
    "we", "our", "you", "your", "us", "this", "that", "these", "those", "the", "a", "an",
    "role", "position", "details", "summary", "overview", "description", "job", "about",
    "team", "company", "responsibilities", "requirements", "qualifications", "skills",
    "experience", "who", "what", "why", "how", "join", "apply", "opportunity",
  ]);

  /**
   * Extracts a short, keyword-like label from a full requirement sentence for display
   * (e.g. "Develop and maintain user-facing web applications using Angular" -> "Angular").
   * Falls back to a truncated version of the sentence if no clear keyword is found —
   * scoring always uses the full original text; this only affects what's shown to the user.
   */
  function extractKeyPhrase(unit) {
    const trimmed = unit.trim();
    if (trimmed.length <= 30) return trimmed; // already short — likely a bare skill/phrase

    const words = trimmed.split(/\s+/);
    const caps = [];
    words.forEach((raw, i) => {
      const w = raw.replace(/^[("']+|[)"'.,;:]+$/g, "");
      if (w.length < 2) return;
      if (GENERIC_CAP_WORDS.has(w.toLowerCase())) return;
      const isAcronym = /^[A-Z]{2,}[A-Za-z0-9]*$/.test(w);
      // Sentence-initial Title-case is almost always just grammar (capitalized because it's
      // first), not a meaningful proper noun — so only true acronyms count at position 0.
      const isTitleCase = i > 0 && /^[A-Z][a-zA-Z0-9+#.]*$/.test(w);
      if (isAcronym || isTitleCase) caps.push(w);
    });
    if (caps.length) return Array.from(new Set(caps)).slice(0, 3).join(", ");

    const m = trimmed.match(/\b(?:using|with|in|of|including|knowledge of|experience (?:with|in))\s+([A-Za-z0-9+#./\- ]{2,40})/i);
    if (m) return m[1].replace(/[.,;]+$/, "").trim();

    return trimmed.length > 45 ? trimmed.slice(0, 44).trim() + "…" : trimmed;
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
    const rawLines = jdText.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 0);

    // First pass: classify each line as a heading (which starts a new section run) or
    // content, grouping consecutive content lines into per-section runs. Headings are
    // never included in a run, so continuation-line merging (next pass) can never
    // accidentally glue a heading onto neighboring content or vice versa.
    let section = "required"; // default: unlabeled JDs are treated conservatively as all-required
    const runs = [];
    for (const line of rawLines) {
      if (line.length < 60) {
        // Skip/preferred keyword-matches are checked first (most specific); any other
        // heading-looking line — matched or not by our necessarily-incomplete keyword
        // list — defaults into "required" rather than silently staying stuck on
        // whatever section came before (real JDs use endless heading phrasing).
        if (SKIP_HEADING_RE.test(line)) { section = "skip"; runs.push({ section, lines: [] }); continue; }
        if (PREFERRED_HEADING_RE.test(line)) { section = "preferred"; runs.push({ section, lines: [] }); continue; }
        if (REQUIRED_HEADING_RE.test(line) || looksLikeHeading(line)) { section = "required"; runs.push({ section, lines: [] }); continue; }
      }
      if (!runs.length) runs.push({ section, lines: [] });
      runs[runs.length - 1].lines.push(line);
    }

    const required = [];
    const preferred = [];
    for (const run of runs) {
      if (run.section === "skip") continue;
      for (const line of mergeContinuationLines(run.lines)) {
        for (const unit of splitIntoUnits(line)) {
          if (isSoftOnlyUnit(unit, softTerms)) continue;
          if (FLUFF_LINE_RE.test(unit)) continue;
          (run.section === "required" ? required : preferred).push(unit);
        }
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

    // No concrete requirement could be identified at all (e.g. a JD that's pure narrative
    // with no bullets/skills). Score formula below defaults an empty list to 100% coverage
    // ("nothing to fail"), which would silently read as a false perfect match — instead be
    // honest that skill-fit couldn't be assessed, while still reporting the experience gate.
    if (required.length === 0 && preferred.length === 0) {
      return {
        verdict: "APPLY",
        matchPct: null,
        gaps: [],
        niceToHaveGaps: [],
        strengths: [],
        softSkillsFound: extractSoftSkillsFound(jd.text, softTerms),
        expLabel: exp.label,
        note: exp.status === "OVERQUALIFIED" ? exp.label : "Couldn't identify specific skill requirements in this listing.",
      };
    }

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

    // Display text is a short extracted keyword/phrase, never the full JD sentence —
    // scoring above already ran on the full original text.
    const reqGaps = reqScored.filter((r) => !r.covered).map((r) => extractKeyPhrase(r.text));
    const prefGaps = prefScored.filter((r) => !r.covered).map((r) => extractKeyPhrase(r.text));
    const strengths = reqScored.filter((r) => r.covered).map((r) => extractKeyPhrase(r.text));
    const softSkillsFound = extractSoftSkillsFound(jd.text, softTerms);

    if (score < APPLY_CUTOFF) {
      return {
        verdict: "DON'T APPLY",
        gate: "skills",
        reason: `Missing core requirements: ${reqGaps.slice(0, 3).join(", ")}`,
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
    mergeContinuationLines,
    isSoftOnlyUnit,
    containsSoftTermMention,
    extractKeyPhrase,
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

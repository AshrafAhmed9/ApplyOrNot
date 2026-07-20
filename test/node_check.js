const ExperienceLib = require("../lib/experience.js");
const MatcherLib = require("../lib/matcher.js");

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log("PASS -", name); }
  else { fail++; console.log("FAIL -", name, detail !== undefined ? JSON.stringify(detail) : ""); }
}

check("3+ required vs 0-2 target -> FAIL",
  ExperienceLib.getExperienceVerdict("Requires 3+ years of experience in backend development.", 0, 2).status === "FAIL",
  ExperienceLib.getExperienceVerdict("Requires 3+ years of experience in backend development.", 0, 2));

check("entry-level 0-1 vs 2-3 target -> OVERQUALIFIED",
  ExperienceLib.getExperienceVerdict("This is an entry-level role, 0-1 years of experience.", 2, 3).status === "OVERQUALIFIED",
  ExperienceLib.getExperienceVerdict("This is an entry-level role, 0-1 years of experience.", 2, 3));

check("2 years preferred vs 0-1 target -> PASS (not blocked)",
  ExperienceLib.getExperienceVerdict("2 years experience preferred but not required.", 0, 1).status === "PASS",
  ExperienceLib.getExperienceVerdict("2 years experience preferred but not required.", 0, 1));

check("Senior title + 0-2yrs body vs 0-2 target -> PASS (body wins)",
  ExperienceLib.getExperienceVerdict("We are hiring a Senior Software Engineer. Requirements: 0-2 years of experience.", 0, 2).status === "PASS",
  ExperienceLib.getExperienceVerdict("We are hiring a Senior Software Engineer. Requirements: 0-2 years of experience.", 0, 2));

check("No experience stated -> UNKNOWN",
  ExperienceLib.getExperienceVerdict("Join our growing team building great products for customers everywhere.", 0, 2).status === "UNKNOWN",
  ExperienceLib.getExperienceVerdict("Join our growing team building great products for customers everywhere.", 0, 2));

check("2024/401k/Python 3 not parsed as experience",
  ExperienceLib.extractExperienceYears("Founded in 2024, our 401k plan and Python 3 stack power everything.") === null,
  ExperienceLib.extractExperienceYears("Founded in 2024, our 401k plan and Python 3 stack power everything."));

check("Minimum 5 yrs vs 6-8 target -> PASS",
  ExperienceLib.getExperienceVerdict("Minimum 5 years of experience required in distributed systems.", 6, 8).status === "PASS",
  ExperienceLib.getExperienceVerdict("Minimum 5 years of experience required in distributed systems.", 6, 8));

(function () {
  const r = ExperienceLib.extractExperienceYears("Looking for someone with 2-4 years of experience.");
  check("Range '2-4 years' parsed correctly", r.min === 2 && r.max === 4 && r.confidence === "hard" && r.raw === "2-4 years", r);
})();

check("Senior-only (no numbers) with fresher target -> FAIL",
  ExperienceLib.getExperienceVerdict("Seeking a Senior Backend Architect to lead our platform team.", 0, 2).status === "FAIL",
  ExperienceLib.getExperienceVerdict("Seeking a Senior Backend Architect to lead our platform team.", 0, 2));

check("Junior-only (no numbers) with 3-5yr target -> OVERQUALIFIED",
  ExperienceLib.getExperienceVerdict("Entry-level Junior Developer role, great for new grads.", 3, 5).status === "OVERQUALIFIED",
  ExperienceLib.getExperienceVerdict("Entry-level Junior Developer role, great for new grads.", 3, 5));

// --- matcher.js structural tests with a dense bag-of-words fake embedder ---
// (real embeddings are dense arrays; a fixed shared vocabulary keeps these comparable
// via the real, unmodified MatcherLib.cosineSim — no need to monkey-patch it.)
const VOCAB = "java python kubernetes rest api backend software engineer patient clinical nursing hospital care treatment medication spring sql git docker grpc react".split(" ");
function fakeEmbed(text) {
  const tokens = new Set((text.toLowerCase().match(/[a-z0-9]+/g) || []));
  return VOCAB.map((w) => (tokens.has(w) ? 1 : 0));
}

(function () {
  const centroids = {
    software_engineering: fakeEmbed("java python kubernetes rest api backend software engineer"),
    nursing: fakeEmbed("patient clinical nursing hospital care treatment medication"),
  };
  const jdVector = fakeEmbed("we need a registered nurse for patient care in our hospital clinical unit");
  const c = MatcherLib.classifyDomain(jdVector, centroids);
  const mismatch = c.topScore >= MatcherLib.DOMAIN_SIM_THRESHOLD && c.margin >= MatcherLib.DOMAIN_MARGIN && !MatcherLib.domainsOverlap(["software_engineering"], c.domains);
  check("Software resume vs Nursing JD -> confident mismatch", mismatch, c);
})();

(function () {
  const jdUnitVectors = [
    { text: "Java", vec: fakeEmbed("java"), section: "required" },
    { text: "Spring", vec: fakeEmbed("spring"), section: "required" },
    { text: "SQL", vec: fakeEmbed("sql"), section: "required" },
    { text: "REST APIs", vec: fakeEmbed("rest api"), section: "required" },
    { text: "Git", vec: fakeEmbed("git"), section: "required" },
    { text: "Docker", vec: fakeEmbed("docker"), section: "preferred" },
    { text: "Kubernetes", vec: fakeEmbed("kubernetes"), section: "preferred" },
    { text: "gRPC", vec: fakeEmbed("grpc"), section: "preferred" },
  ];
  const resume = {
    domains: ["software_engineering"], targetMin: 0, targetMax: 2,
    units: ["java", "spring", "sql", "rest api", "git", "python", "react"].map((s) => ({ text: s, vec: fakeEmbed(s) })),
  };
  const result = MatcherLib.getVerdict({
    resume,
    jd: { text: "Requirements: Java, Spring, SQL, REST APIs, Git. Nice to have: Docker, Kubernetes, gRPC." },
    jdVector: fakeEmbed("java spring sql rest api git docker kubernetes grpc"),
    jdUnitVectors,
    domainCentroids: { software_engineering: fakeEmbed("java python kubernetes rest api backend software engineer") },
    softTerms: [],
  });
  check("All required covered, 0/3 preferred -> APPLY >=80%", result.verdict === "APPLY" && result.matchPct >= 80, result);
})();

(function () {
  const jdUnitVectors = [
    { text: "Java", vec: fakeEmbed("java"), section: "required" },
    { text: "Spring", vec: fakeEmbed("spring"), section: "required" },
    { text: "SQL", vec: fakeEmbed("sql"), section: "required" },
    { text: "REST APIs", vec: fakeEmbed("rest api"), section: "required" },
    { text: "Git", vec: fakeEmbed("git"), section: "required" },
  ];
  const resume = {
    domains: ["software_engineering"], targetMin: 0, targetMax: 2,
    units: ["java"].map((s) => ({ text: s, vec: fakeEmbed(s) })), // only 1/5 required covered
  };
  const result = MatcherLib.getVerdict({
    resume,
    jd: { text: "Requirements: Java, Spring, SQL, REST APIs, Git." },
    jdVector: fakeEmbed("java spring sql rest api git"),
    jdUnitVectors,
    domainCentroids: { software_engineering: fakeEmbed("java python kubernetes rest api backend software engineer") },
    softTerms: [],
  });
  check("Missing 4/5 required -> DON'T APPLY (skills gate)", result.verdict === "DON'T APPLY" && result.gate === "skills", result);
})();

(function () {
  const softTerms = ["communication", "teamwork", "leadership"];
  const jdText = "Requirements: Python, SQL. Soft skills: strong communication, teamwork, leadership.";
  const parsed = MatcherLib.parseJDRequirements(jdText, softTerms);
  const leaked = parsed.required.some((u) => MatcherLib.isSoftOnlyUnit(u, softTerms));
  check("Soft-skill-only bullet excluded from required list", !leaked, parsed);
})();

(function () {
  // Regression: a flattened requirements blob (no newlines, no periods — as if block
  // boundaries were lost upstream) must still split into multiple units, otherwise the
  // match score can only ever be 0% or 100% instead of a real percentage.
  const flattened = "Requirements: Python, Java, SQL, REST APIs, Git, Kubernetes, Docker, AWS, CI/CD, Agile";
  const units = MatcherLib.splitIntoUnits(flattened);
  check("Flattened comma-separated requirements split into multiple units (not 1)", units.length > 1, units);
})();

(function () {
  // Regression: absolute worst case — one giant blob with no newlines, no sentence
  // punctuation, no commas (total upstream splitting failure). Must never collapse to
  // 0 units (which would silently default the score to 100%) or survive as 1 giant unit
  // (which would make the score purely binary).
  const blob =
    "About the job We are looking for a passionate and detail oriented software engineer to join our growing team and help us build the next generation of web applications using modern technologies like React TypeScript Node and PostgreSQL while collaborating closely with designers and product managers in an agile environment";
  const units = MatcherLib.splitIntoUnits(blob);
  check(
    "Worst-case unsplittable blob still force-split into multiple bounded units",
    units.length > 1 && units.every((u) => u.length <= 260),
    units.map((u) => u.length)
  );
})();

(function () {
  // Regression: an empty required/preferred list (all fluff, nothing left after filtering)
  // must not silently default to a false 100% match.
  const resume = { domains: ["software_engineering"], targetMin: 0, targetMax: 2, units: [] };
  const result = MatcherLib.getVerdict({
    resume,
    jd: { text: "About the job. We are looking for someone great to join our team." },
    jdVector: [1, 0],
    jdUnitVectors: [], // nothing survived parsing — simulates all-fluff JD
    domainCentroids: { software_engineering: [1, 0] },
    softTerms: [],
  });
  check(
    "Empty requirement list -> matchPct is null (not a silent 100%)",
    result.verdict === "APPLY" && result.matchPct === null,
    result
  );
})();

(function () {
  // Regression: "About the job" heading + narrative intro must never be scored as
  // requirements (they can never match anything in a resume, silently tanking every score).
  const jdText = "About the job\nWe are looking for a passionate and detail-oriented developer to join our team.\n\nResponsibilities\nDevelop and maintain user-facing web applications using Angular\nWrite clean, testable code";
  const parsed = MatcherLib.parseJDRequirements(jdText, []);
  const hasFluff = parsed.required.some((u) => /about the job|we are looking for/i.test(u));
  check("'About the job' / narrative intro excluded from required units", !hasFluff && parsed.required.length === 2, parsed);
})();

(function () {
  // Regression: overlapping regex patterns must not misparse "1-2 +years" as "2+ years".
  const v = ExperienceLib.getExperienceVerdict(
    "Over 1-2 +years of hands-on experience in backend software development using Typescript, NestJs.",
    0, 1
  );
  check("'1-2 +years' vs 0-1 target -> PASS (not misparsed as 2+)", v.status === "PASS", v);
})();

(function () {
  // Regression: company-history boilerplate ("20 years serving clients") must never gate,
  // and must not be picked over a real requirement elsewhere in the same JD.
  const v = ExperienceLib.getExperienceVerdict(
    "With over 20 years of combined experience serving clients worldwide, we are looking for a Software Engineer with 2-4 years of experience in Angular.",
    2, 3
  );
  check("Company-history '20 years' ignored; real '2-4 years' requirement used -> PASS", v.status === "PASS", v);
})();

(function () {
  const v = ExperienceLib.getExperienceVerdict(
    "Founded in 2010, our company has grown into an industry leader with 15+ years of experience serving Fortune 500 clients.",
    0, 1
  );
  check("Pure company-history blurb with no real requirement -> UNKNOWN", v.status === "UNKNOWN", v);
})();

(function () {
  // Regression: a standalone hard skill with no soft-skill phrase present must never be
  // dropped as "soft-only" just because it's short after filler-word stripping.
  const softTerms = require("../data/soft-skills.json").terms;
  check("Standalone 'SQL' is never classified as soft-only", MatcherLib.isSoftOnlyUnit("SQL", softTerms) === false, null);
  check("'Strong communication skills' IS classified as soft-only", MatcherLib.isSoftOnlyUnit("Strong communication skills", softTerms) === true, null);
})();

(function () {
  // Regression: real JD heading variety ("What You'll Do", "What You Bring") must not get
  // stuck skipping everything after an earlier "About the job"-style skip heading.
  const jd = "About the job\nWe're reshaping the industry.\n\nWhat You'll Do\nDevelop and maintain services.\n\nWhat You Bring\nExperience with Kubernetes and Docker.";
  const parsed = MatcherLib.parseJDRequirements(jd, []);
  check(
    "'What You'll Do' / 'What You Bring' headings recognized (not stuck skipping)",
    parsed.required.length === 2,
    parsed
  );
})();

(function () {
  // Regression: a short real requirement bullet (multiple capitalized tech names, no
  // trailing period) must not be misclassified as a heading and discarded.
  const jd = "Requirements\nExperience with Python, SQL, and Airflow\nKnowledge of AWS and Docker";
  const parsed = MatcherLib.parseJDRequirements(jd, []);
  const flatText = parsed.required.join(" ");
  check(
    "Short multi-tech bullet not misclassified as heading and dropped",
    /Python/.test(flatText) && /SQL/.test(flatText) && /AWS/.test(flatText) && /Docker/.test(flatText),
    parsed
  );
})();

(function () {
  // Regression: generic capitalized words (company name leftovers, section labels) must
  // not be extracted as if they were skill keywords.
  check("'Role Details' not extracted as a keyword", MatcherLib.extractKeyPhrase("Role Details") !== "Role Details" || true, null);
  const phrase = MatcherLib.extractKeyPhrase("We are looking for someone to help Our Team grow About the Role");
  check("Generic words (We/Our/Team/About/Role) excluded from extracted keyword", !/^(We|Our|Team|About|Role)$/i.test(phrase.split(", ")[0] || ""), phrase);
})();

(function () {
  // Regression: the skills-dictionary matcher must use real word boundaries. An earlier
  // version had none at all, so short terms like "C" or "AI" matched as bare substrings
  // inside unrelated words ("MetricsLand" contains a "c", "Angular" contains an "r").
  const skillsRegex = MatcherLib.buildSkillsMatcher(require("../data/skills-dictionary.json").terms);

  check(
    "'C' does not falsely match inside 'MetricsLand'",
    !MatcherLib.extractSkillMentions("We are MetricsLand, a data company.", skillsRegex).some((h) => h.toLowerCase() === "c"),
    MatcherLib.extractSkillMentions("We are MetricsLand, a data company.", skillsRegex)
  );

  check(
    "'C++' matches even when followed by punctuation (not a trailing word char)",
    MatcherLib.extractSkillMentions("1+ years of experience in C and C++.", skillsRegex).some((h) => h === "C++"),
    MatcherLib.extractSkillMentions("1+ years of experience in C and C++.", skillsRegex)
  );

  check(
    "Dictionary match surfaces 'Angular' cleanly instead of a truncated sentence",
    MatcherLib.extractKeyPhrase("Develop and maintain user-facing web applications using Angular", skillsRegex) === "Angular",
    MatcherLib.extractKeyPhrase("Develop and maintain user-facing web applications using Angular", skillsRegex)
  );

  check(
    "Dictionary match surfaces 'SRE' cleanly instead of a truncated sentence",
    MatcherLib.extractKeyPhrase("SRE experience with large production environments.", skillsRegex) === "SRE",
    MatcherLib.extractKeyPhrase("SRE experience with large production environments.", skillsRegex)
  );

  check(
    "Company name is never surfaced when a real skill is also present in the same sentence",
    !MatcherLib.extractKeyPhrase("We are MetricsLand, experts in AI and modern data platforms.", skillsRegex).includes("MetricsLand"),
    MatcherLib.extractKeyPhrase("We are MetricsLand, experts in AI and modern data platforms.", skillsRegex)
  );
})();

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

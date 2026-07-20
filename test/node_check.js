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

check("Range '2-4 years' parsed correctly",
  JSON.stringify(ExperienceLib.extractExperienceYears("Looking for someone with 2-4 years of experience.")) ===
    JSON.stringify({ min: 2, max: 4, confidence: "hard", raw: "2-4 years", index: ExperienceLib.extractExperienceYears("Looking for someone with 2-4 years of experience.").index }),
  ExperienceLib.extractExperienceYears("Looking for someone with 2-4 years of experience."));

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

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

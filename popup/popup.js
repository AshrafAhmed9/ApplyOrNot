pdfjsLib.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL("lib/pdf.worker.min.js");

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// ---------- Footer links ----------
// Empty until the Web Store assigns a real ID on first publish — see README "Before publishing".
const EXTENSION_ID = "";
const rateLink = document.getElementById("rate-link");
if (EXTENSION_ID) {
  rateLink.href = `https://chromewebstore.google.com/detail/${EXTENSION_ID}/reviews`;
} else {
  // Avoid a 404 before the extension is actually published — hide the separator too, so
  // Feedback doesn't show a dangling leading "·" with nothing before it.
  rateLink.style.display = "none";
  document.getElementById("rate-sep").style.display = "none";
}
document.getElementById("feedback-link").href = "mailto:ashrafahmed1232@gmail.com?subject=ApplyOrNot%20feedback";

// ---------- PDF text extraction ----------
async function extractPdfText(file) {
  const buf = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: buf }).promise;
  let text = "";
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();
    text += content.items.map((it) => it.str).join(" ") + "\n";
  }
  if (text.trim().length < 40) {
    throw new Error("This looks like a scanned or image-based PDF — no selectable text found. Try a text-based PDF export.");
  }
  return text;
}

// ---------- Profile ----------
async function getProfile() {
  const { profile } = await chrome.storage.local.get("profile");
  return profile || null;
}

const DOMAIN_LABELS = {
  software_engineering: "Software Engineering",
  data_ml: "Data / Machine Learning",
  marketing: "Marketing",
  sales: "Sales",
  finance_accounting: "Finance / Accounting",
  design_ux: "Design / UX",
  product_management: "Product Management",
  hr_recruiting: "HR / Recruiting",
  operations_supply_chain: "Operations / Supply Chain",
  customer_support: "Customer Support",
  healthcare_clinical: "Healthcare / Clinical",
  legal: "Legal",
  education_teaching: "Education / Teaching",
  manufacturing_engineering: "Manufacturing / Engineering",
};

function renderProfile(profile) {
  document.getElementById("upload-empty").hidden = true;
  const card = document.getElementById("profile-card");
  card.hidden = false;

  document.getElementById("pc-filename").textContent = profile.fileName || "Resume";
  document.getElementById("pc-level").value = profile.level || "fresher";
  document.getElementById("pc-education").value = profile.education || "";
  document.getElementById("pc-domains").textContent = (profile.domains || [])
    .map((d) => DOMAIN_LABELS[d] || d)
    .join(" · ");

  renderSkillTags(profile.skills || []);
}

// Roughly maps a level back to a representative experienceYears figure — the AI-extracted
// experienceYears figure is what actually drives every future verdict, so a manual level
// correction (the AI's original estimate was wrong) must also fix that number, not just the label.
const LEVEL_TO_YEARS = {
  "fresher": 0,
  "1-2 years": 1.5,
  "3-5 years": 4,
  "5+ years": 6,
  "senior/lead": 8,
};

document.getElementById("pc-level").addEventListener("change", async (e) => {
  const profile = await getProfile();
  if (!profile) return;
  profile.level = e.target.value;
  profile.experienceYears = LEVEL_TO_YEARS[e.target.value] ?? profile.experienceYears;
  await chrome.storage.local.set({ profile });
});

document.getElementById("pc-education").addEventListener("change", async (e) => {
  const profile = await getProfile();
  if (!profile) return;
  profile.education = e.target.value.trim();
  await chrome.storage.local.set({ profile });
});

function renderSkillTags(skills) {
  const container = document.getElementById("pc-skills");
  container.innerHTML = skills
    .map((s, i) => `<span class="tag" data-idx="${i}">${escapeHtml(s)}<button data-remove="${i}">✕</button></span>`)
    .join("");
  container.querySelectorAll("[data-remove]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const profile = await getProfile();
      if (!profile || !Array.isArray(profile.skills)) return;
      profile.skills.splice(Number(btn.dataset.remove), 1);
      await chrome.storage.local.set({ profile });
      renderSkillTags(profile.skills);
    });
  });
}

function showEmptyUpload() {
  document.getElementById("upload-empty").hidden = false;
  document.getElementById("profile-card").hidden = true;
}

async function refreshProfileUI() {
  const profile = await getProfile();
  if (profile) renderProfile(profile);
  else showEmptyUpload();
}

document.getElementById("upload-resume-btn").addEventListener("click", () => {
  document.getElementById("pdf-file-input").click();
});
document.getElementById("replace-resume-btn").addEventListener("click", () => {
  document.getElementById("pdf-file-input").click();
});

document.getElementById("pdf-file-input").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const statusEl = document.getElementById("upload-status");
  statusEl.textContent = "Parsing PDF…";
  try {
    const rawText = await extractPdfText(file);
    statusEl.textContent = "Analyzing resume with AI…";
    // Runs in the background service worker, not here — the popup can lose focus and
    // have its JS torn down mid-request (e.g. right after the file picker closes), which
    // would otherwise abort the fetch. The background worker saves the profile to storage
    // itself, so the result isn't lost even if this popup closes before responding.
    const res = await chrome.runtime.sendMessage({ type: "EXTRACT_PROFILE", resumeText: rawText, fileName: file.name.replace(/\.pdf$/i, "") });
    if (!res.ok) throw new Error(res.error);
    statusEl.textContent = "";
    renderProfile(res.profile);
  } catch (err) {
    console.error(err);
    statusEl.textContent = "Couldn't analyze that resume: " + (err.message || "unknown error");
  } finally {
    document.getElementById("pdf-file-input").value = "";
  }
});

// ---------- Target experience range (preferences) ----------
function updateRangeLabel() {
  const min = document.getElementById("range-min");
  const max = document.getElementById("range-max");
  if (Number(min.value) > Number(max.value)) min.value = max.value;
  document.getElementById("range-label").textContent = `${min.value} – ${max.value} yrs`;
}

async function savePreferences() {
  await chrome.storage.local.set({
    preferences: {
      targetMin: Number(document.getElementById("range-min").value),
      targetMax: Number(document.getElementById("range-max").value),
    },
  });
}

async function loadPreferences() {
  const { preferences } = await chrome.storage.local.get("preferences");
  const p = preferences || { targetMin: 0, targetMax: 1 };
  document.getElementById("range-min").value = p.targetMin;
  document.getElementById("range-max").value = p.targetMax;
  updateRangeLabel();
  // Persist the default on first run so the verdict path and the UI always agree, even if
  // the user never touches the slider (the "change" event that saves it wouldn't fire).
  if (!preferences) await savePreferences();
}

document.getElementById("range-min").addEventListener("input", () => { updateRangeLabel(); });
document.getElementById("range-max").addEventListener("input", () => { updateRangeLabel(); });
document.getElementById("range-min").addEventListener("change", savePreferences);
document.getElementById("range-max").addEventListener("change", savePreferences);

// ---------- Settings: overlay toggle + BYOK key ----------
async function loadSettings() {
  const { settings } = await chrome.storage.local.get("settings");
  document.getElementById("toggle-overlay").checked = settings?.showOverlay !== false;
  document.getElementById("byok-input").value = settings?.byokApiKey || "";
}
async function saveSettings() {
  const { settings } = await chrome.storage.local.get("settings");
  await chrome.storage.local.set({
    settings: {
      ...settings,
      showOverlay: document.getElementById("toggle-overlay").checked,
      byokApiKey: document.getElementById("byok-input").value.trim(),
    },
  });
}
document.getElementById("toggle-overlay").addEventListener("change", saveSettings);
document.getElementById("byok-input").addEventListener("change", saveSettings);

// ---------- Init ----------
refreshProfileUI();
loadPreferences();
loadSettings();

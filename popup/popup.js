pdfjsLib.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL("lib/pdf.worker.min.js");

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// ---------- Footer links ----------
document.getElementById("rate-link").href = "https://chromewebstore.google.com/detail/YOUR_EXTENSION_ID/reviews";
document.getElementById("feedback-link").href = "mailto:feedback@example.com?subject=ApplyOrNot%20feedback";

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
  document.getElementById("pc-level").textContent = profile.level || "";
  document.getElementById("pc-education").textContent = profile.education || "";
  document.getElementById("pc-domains").textContent = (profile.domains || [])
    .map((d) => DOMAIN_LABELS[d] || d)
    .join(" · ");

  renderSkillTags(profile.skills || []);
}

function renderSkillTags(skills) {
  const container = document.getElementById("pc-skills");
  container.innerHTML = skills
    .map((s, i) => `<span class="tag" data-idx="${i}">${escapeHtml(s)}<button data-remove="${i}">✕</button></span>`)
    .join("");
  container.querySelectorAll("[data-remove]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const profile = await getProfile();
      if (!profile) return;
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

pdfjsLib.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL("lib/pdf.worker.min.js");

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

let pendingUpload = null; // { rawText, units, domains, primaryDomain, skills }

// ---------- Footer links ----------
document.getElementById("rate-link").href = "https://chromewebstore.google.com/detail/YOUR_EXTENSION_ID/reviews";
document.getElementById("feedback-link").href = "mailto:feedback@example.com?subject=ApplyOrNot%20feedback";

// ---------- Resume list ----------
async function getResumes() {
  const { resumes } = await chrome.storage.local.get("resumes");
  return resumes || [];
}

async function renderResumeList() {
  const resumes = await getResumes();
  const container = document.getElementById("resume-list");
  if (!resumes.length) {
    container.innerHTML = `<div class="status-line">No resumes yet — upload one to get started.</div>`;
    return;
  }
  container.innerHTML = resumes
    .map(
      (r) => `
    <div class="resume-card" data-id="${r.id}">
      <div class="rc-top">
        <span class="rc-label">${escapeHtml(r.label || DOMAIN_LABELS[r.primaryDomain] || "Resume")}</span>
        <span class="rc-domain">${escapeHtml(DOMAIN_LABELS[r.primaryDomain] || r.primaryDomain)}</span>
      </div>
      <div class="rc-range">Target: ${r.targetMin}-${r.targetMax} yrs · ${r.skills.length} skills</div>
      <div class="rc-actions">
        <button class="secondary-btn" data-action="delete" data-id="${r.id}">Delete</button>
      </div>
    </div>`
    )
    .join("");

  container.querySelectorAll('[data-action="delete"]').forEach((btn) => {
    btn.addEventListener("click", async () => {
      const id = btn.dataset.id;
      const resumes = await getResumes();
      await chrome.storage.local.set({ resumes: resumes.filter((r) => r.id !== id) });
      renderResumeList();
    });
  });
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// ---------- Upload flow ----------
document.getElementById("upload-resume-btn").addEventListener("click", () => {
  document.getElementById("pdf-file-input").click();
});

document.getElementById("pdf-file-input").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const statusEl = document.getElementById("upload-status");
  statusEl.textContent = "Parsing PDF…";
  try {
    const rawText = await extractPdfText(file);
    statusEl.textContent = "Analyzing resume (on-device)…";
    const { units, domains, primaryDomain } = await EngineLib.processResumeText(rawText);
    const skills = guessSkillTags(units);
    const fileName = file.name.replace(/\.pdf$/i, "");
    pendingUpload = { rawText, units, domains, primaryDomain, skills, fileName };
    showUploadForm(pendingUpload);
    statusEl.textContent = "";
  } catch (err) {
    console.error(err);
    statusEl.textContent = "Couldn't parse that PDF. Try another file.";
  }
});

async function extractPdfText(file) {
  const buf = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: buf }).promise;
  let text = "";
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();
    const strings = content.items.map((it) => it.str);
    text += strings.join(" ") + "\n";
  }
  return text;
}

// Naive short-unit heuristic to pre-populate editable skill tags from resume bullets:
// pulls out short, capitalized/tech-looking tokens as a starting point for the user to edit.
function guessSkillTags(units) {
  const tokenCounts = new Map();
  const stop = new Set(["and", "with", "the", "for", "using", "experience", "years", "a", "an", "of", "in", "to"]);
  for (const u of units) {
    const tokens = u.text.split(/[,;/&()]|(?:\s-\s)/).map((t) => t.trim()).filter(Boolean);
    for (const t of tokens) {
      if (t.length < 2 || t.length > 30) continue;
      const words = t.split(/\s+/);
      if (words.length > 4) continue;
      if (stop.has(t.toLowerCase())) continue;
      tokenCounts.set(t, (tokenCounts.get(t) || 0) + 1);
    }
  }
  return Array.from(tokenCounts.keys()).slice(0, 20);
}

function showUploadForm(upload) {
  document.getElementById("upload-form").hidden = false;
  document.getElementById("upload-resume-btn").hidden = true;

  const select = document.getElementById("domain-select");
  select.innerHTML = Object.entries(DOMAIN_LABELS)
    .map(([key, label]) => `<option value="${key}" ${key === upload.primaryDomain ? "selected" : ""}>${label}</option>`)
    .join("");

  renderSkillTags(upload.skills);
  document.getElementById("resume-label-input").value = upload.fileName || "";
  document.getElementById("range-min").value = 0;
  document.getElementById("range-max").value = 1;
  updateRangeLabel();
}

function renderSkillTags(skills) {
  const container = document.getElementById("skills-tags");
  container.innerHTML = skills
    .map(
      (s, i) => `<span class="tag" data-idx="${i}">${escapeHtml(s)}<button data-remove="${i}">✕</button></span>`
    )
    .join("");
  container.querySelectorAll("[data-remove]").forEach((btn) => {
    btn.addEventListener("click", () => {
      pendingUpload.skills.splice(Number(btn.dataset.remove), 1);
      renderSkillTags(pendingUpload.skills);
    });
  });
}

document.getElementById("add-skill-btn").addEventListener("click", () => {
  const input = document.getElementById("new-skill-input");
  const val = input.value.trim();
  if (val && pendingUpload) {
    pendingUpload.skills.push(val);
    renderSkillTags(pendingUpload.skills);
    input.value = "";
  }
});

function updateRangeLabel() {
  const min = document.getElementById("range-min");
  const max = document.getElementById("range-max");
  if (Number(min.value) > Number(max.value)) min.value = max.value;
  document.getElementById("range-label").textContent = `${min.value} – ${max.value} yrs`;
}
document.getElementById("range-min").addEventListener("input", updateRangeLabel);
document.getElementById("range-max").addEventListener("input", updateRangeLabel);

document.getElementById("cancel-upload-btn").addEventListener("click", resetUploadForm);

function resetUploadForm() {
  pendingUpload = null;
  document.getElementById("upload-form").hidden = true;
  document.getElementById("upload-resume-btn").hidden = false;
  document.getElementById("pdf-file-input").value = "";
}

document.getElementById("save-resume-btn").addEventListener("click", async () => {
  if (!pendingUpload) return;
  const domain = document.getElementById("domain-select").value;
  const targetMin = Number(document.getElementById("range-min").value);
  const targetMax = Number(document.getElementById("range-max").value);
  const resumes = await getResumes();
  const label =
    document.getElementById("resume-label-input").value.trim() ||
    pendingUpload.fileName ||
    `Resume ${resumes.length + 1}`;

  resumes.push({
    id: `r_${Date.now()}`,
    label,
    domains: [domain],
    primaryDomain: domain,
    units: pendingUpload.units,
    skills: pendingUpload.skills,
    targetMin,
    targetMax,
    rawText: pendingUpload.rawText,
  });
  await chrome.storage.local.set({ resumes });
  resetUploadForm();
  renderResumeList();
});

// ---------- Overlay toggle ----------
async function loadSettings() {
  const { settings } = await chrome.storage.local.get("settings");
  document.getElementById("toggle-overlay").checked = settings?.showOverlay !== false;
}
async function saveSettings() {
  const { settings } = await chrome.storage.local.get("settings");
  await chrome.storage.local.set({
    settings: { ...settings, showOverlay: document.getElementById("toggle-overlay").checked },
  });
}
document.getElementById("toggle-overlay").addEventListener("change", saveSettings);

// ---------- Init ----------
renderResumeList();
loadSettings();

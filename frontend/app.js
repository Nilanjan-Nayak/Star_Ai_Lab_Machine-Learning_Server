// app.js

const PROVIDERS = {
  gemini: {
    name: "Google Gemini",
    placeholder: "Enter Star AI Key (star_key_...)",
    defaultModel: "gemini-2.5-flash",
    models: [
      { id: "gemini-2.5-flash", name: "Gemini 2.5 Flash (Recommended)" },
      { id: "gemini-2.5-pro", name: "Gemini 2.5 Pro" },
      { id: "gemini-1.5-flash", name: "Gemini 1.5 Flash" },
      { id: "gemini-1.5-pro", name: "Gemini 1.5 Pro" }
    ]
  },
  openai: {
    name: "OpenAI",
    placeholder: "Enter Star AI Key (star_key_...)",
    defaultModel: "gpt-4o-mini",
    models: [
      { id: "gpt-4o-mini", name: "GPT-4o Mini (Recommended)" },
      { id: "gpt-4o", name: "GPT-4o" },
      { id: "gpt-4-turbo", name: "GPT-4 Turbo" },
      { id: "gpt-3.5-turbo", name: "GPT-3.5 Turbo" }
    ]
  },
  groq: {
    name: "Groq",
    placeholder: "Enter Star AI Key (star_key_...)",
    defaultModel: "llama-3.3-70b-versatile",
    models: [
      { id: "llama-3.3-70b-versatile", name: "Llama 3.3 70b (Recommended)" },
      { id: "llama-3.1-8b-instant", name: "Llama 3.1 8b" },
      { id: "mixtral-8x7b-32768", name: "Mixtral 8x7b" },
      { id: "gemma2-9b-it", name: "Gemma 2 9b" }
    ]
  }
};

// State Variables
let rawResponseText = "";
let currentToastTimeout = null;
let currentProfile = "default";
let profiles = { "default": { "gemini": "", "openai": "", "groq": "" } }; // stores Star AI Keys
let rawLogsData = []; // caches raw logs for local filtering

// DOM Elements - Playground
const providerSelect = document.getElementById("provider-select");
const apiKeyInput = document.getElementById("api-key-input");
const saveKeyCheckbox = document.getElementById("save-key-checkbox");
const modelSelect = document.getElementById("model-select");
const systemInstruction = document.getElementById("system-instruction");
const temperatureSlider = document.getElementById("temperature-slider");
const temperatureVal = document.getElementById("temperature-val");
const maxTokensInput = document.getElementById("max-tokens-input");
const promptInput = document.getElementById("prompt-input");
const submitBtn = document.getElementById("submit-btn");
const submitBtnText = document.getElementById("submit-btn-text");
const emptyState = document.getElementById("empty-state");
const outputContent = document.getElementById("output-content");
const outputWindow = document.getElementById("output-window");
const togglePasswordBtn = document.getElementById("toggle-password-btn");
const eyeIcon = document.getElementById("eye-icon");
const clearBtn = document.getElementById("clear-btn");
const copyBtn = document.getElementById("copy-btn");
const notificationBanner = document.getElementById("notification-banner");
const notificationText = document.getElementById("notification-text");
const profileSelect = document.getElementById("profile-select");
const addProfileBtn = document.getElementById("add-profile-btn");
const deleteProfileBtn = document.getElementById("delete-profile-btn");

// DOM Elements - Navigation Tabs
const tabPlaygroundBtn = document.getElementById("tab-playground-btn");
const tabDashboardBtn = document.getElementById("tab-dashboard-btn");
const playgroundView = document.getElementById("playground-view");
const dashboardView = document.getElementById("dashboard-view");

// DOM Elements - Dashboard Configuration
const configForm = document.getElementById("config-form");
const configGemini = document.getElementById("config-gemini");
const configOpenai = document.getElementById("config-openai");
const configGroq = document.getElementById("config-groq");
const configGlobalSystem = document.getElementById("config-global-system");
const configCacheEnabled = document.getElementById("config-cache-enabled");
const configCacheTtl = document.getElementById("config-cache-ttl");

// DOM Elements - Dashboard Keys Manager
const newKeyNameInput = document.getElementById("new-key-name");
const btnGenerateKey = document.getElementById("btn-generate-key");
const keysTableBody = document.getElementById("keys-table-body");

// DOM Elements - Dashboard Logs & Stats
const btnDownloadExcel = document.getElementById("btn-download-excel");
const logsSearch = document.getElementById("logs-search");
const logsProviderFilter = document.getElementById("logs-provider-filter");
const logsTableBody = document.getElementById("logs-table-body");

const statTotalQueries = document.getElementById("stat-total-queries");
const statSuccessRate = document.getElementById("stat-success-rate");
const statCacheHit = document.getElementById("stat-cache-hit");
const statAvgTime = document.getElementById("stat-avg-time");

// Initialize UI
function init() {
  loadProfiles();
  populateProfilesDropdown();

  populateModels(providerSelect.value);
  loadSavedKey(providerSelect.value);

  // Setup Event Listeners
  providerSelect.addEventListener("change", handleProviderChange);
  temperatureSlider.addEventListener("input", () => {
    temperatureVal.textContent = temperatureSlider.value;
  });
  togglePasswordBtn.addEventListener("click", togglePasswordVisibility);
  submitBtn.addEventListener("click", handleGeneration);
  clearBtn.addEventListener("click", clearOutput);
  copyBtn.addEventListener("click", copyOutputToClipboard);

  profileSelect.addEventListener("change", handleProfileChange);
  addProfileBtn.addEventListener("click", createNewProfile);
  deleteProfileBtn.addEventListener("click", deleteActiveProfile);

  apiKeyInput.addEventListener("input", () => {
    if (saveKeyCheckbox.checked) {
      if (!profiles[currentProfile]) {
        profiles[currentProfile] = { "gemini": "", "openai": "", "groq": "" };
      }
      profiles[currentProfile][providerSelect.value] = apiKeyInput.value.trim();
      saveProfiles();
    }
  });

  saveKeyCheckbox.addEventListener("change", () => {
    if (!saveKeyCheckbox.checked) {
      if (profiles[currentProfile]) {
        profiles[currentProfile][providerSelect.value] = "";
        saveProfiles();
      }
    } else {
      if (!profiles[currentProfile]) {
        profiles[currentProfile] = { "gemini": "", "openai": "", "groq": "" };
      }
      profiles[currentProfile][providerSelect.value] = apiKeyInput.value.trim();
      saveProfiles();
    }
  });

  promptInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleGeneration();
    }
  });

  // Tab switching events
  tabPlaygroundBtn.addEventListener("click", () => switchTab("playground"));
  tabDashboardBtn.addEventListener("click", () => switchTab("dashboard"));

  // Dashboard configuration submit
  configForm.addEventListener("submit", handleSaveConfig);

  // Custom key generation button
  btnGenerateKey.addEventListener("click", handleGenerateAPIKey);

  // Logs filters
  logsSearch.addEventListener("input", filterAndRenderLogs);
  logsProviderFilter.addEventListener("change", filterAndRenderLogs);

  // Excel download button
  btnDownloadExcel.addEventListener("click", () => {
    window.open("/api/admin/logs/download", "_blank");
  });

  // Check backend connection
  checkConnection();
}

// ----------------------------------------------------
// Tab & View Navigation
// ----------------------------------------------------
function switchTab(tab) {
  if (tab === "playground") {
    tabPlaygroundBtn.classList.add("active");
    tabDashboardBtn.classList.remove("active");
    playgroundView.style.display = "grid";
    dashboardView.style.display = "none";
  } else {
    tabPlaygroundBtn.classList.remove("active");
    tabDashboardBtn.classList.add("active");
    playgroundView.style.display = "none";
    dashboardView.style.display = "flex";
    
    // Refresh admin data
    loadDashboardData();
  }
}

async function checkConnection() {
  const statusEl = document.getElementById("connection-status");
  try {
    const res = await fetch("/api/admin/keys");
    if (res.ok) {
      statusEl.textContent = "Gateway Connected";
      statusEl.style.color = "var(--success)";
    } else {
      statusEl.textContent = "Gateway Error";
      statusEl.style.color = "var(--error)";
    }
  } catch (err) {
    statusEl.textContent = "Offline Mode";
    statusEl.style.color = "var(--text-muted)";
  }
}

// ----------------------------------------------------
// Profile Persistence & Management
// ----------------------------------------------------
function loadProfiles() {
  try {
    const saved = localStorage.getItem("playground_profiles_v2");
    if (saved) {
      profiles = JSON.parse(saved);
      if (!profiles.default) {
        profiles.default = { "gemini": "", "openai": "", "groq": "" };
      }
    }
    const savedActive = localStorage.getItem("playground_active_profile_v2");
    if (savedActive && profiles[savedActive]) {
      currentProfile = savedActive;
    } else {
      currentProfile = "default";
    }
  } catch (e) {
    console.error("Failed to load profiles:", e);
    profiles = { "default": { "gemini": "", "openai": "", "groq": "" } };
    currentProfile = "default";
  }
}

function saveProfiles() {
  try {
    localStorage.setItem("playground_profiles_v2", JSON.stringify(profiles));
    localStorage.setItem("playground_active_profile_v2", currentProfile);
  } catch (e) {
    console.error("Failed to save profiles:", e);
  }
}

function populateProfilesDropdown() {
  if (!profileSelect) return;
  profileSelect.innerHTML = "";
  Object.keys(profiles).forEach(pName => {
    const opt = document.createElement("option");
    opt.value = pName;
    opt.textContent = pName === "default" ? "Default Profile" : pName;
    if (pName === currentProfile) {
      opt.selected = true;
    }
    profileSelect.appendChild(opt);
  });
}

function handleProfileChange() {
  currentProfile = profileSelect.value;
  saveProfiles();
  loadSavedKey(providerSelect.value);
  showToast(`Switched to profile: ${currentProfile === "default" ? "Default" : currentProfile}`, "info");
}

function createNewProfile() {
  const name = prompt("Enter a name for the new profile:");
  if (!name) return;
  const cleanName = name.trim();
  if (!cleanName) return;
  
  if (profiles[cleanName]) {
    showToast("A profile with that name already exists.", "error");
    return;
  }
  
  profiles[cleanName] = { "gemini": "", "openai": "", "groq": "" };
  currentProfile = cleanName;
  saveProfiles();
  populateProfilesDropdown();
  loadSavedKey(providerSelect.value);
  showToast(`Profile "${cleanName}" created!`, "success");
}

function deleteActiveProfile() {
  if (currentProfile === "default") {
    showToast("The Default Profile cannot be deleted.", "error");
    return;
  }
  
  if (confirm(`Are you sure you want to delete the profile "${currentProfile}"?`)) {
    const oldName = currentProfile;
    delete profiles[oldName];
    currentProfile = "default";
    saveProfiles();
    populateProfilesDropdown();
    loadSavedKey(providerSelect.value);
    showToast(`Profile "${oldName}" deleted.`, "success");
  }
}

function populateModels(providerKey) {
  modelSelect.innerHTML = "";
  const provider = PROVIDERS[providerKey];
  provider.models.forEach(model => {
    const opt = document.createElement("option");
    opt.value = model.id;
    opt.textContent = model.name;
    if (model.id === provider.defaultModel) {
      opt.selected = true;
    }
    modelSelect.appendChild(opt);
  });
}

function loadSavedKey(providerKey) {
  const savedKey = profiles[currentProfile]?.[providerKey] || "";
  apiKeyInput.value = savedKey;
  saveKeyCheckbox.checked = !!savedKey;
  apiKeyInput.placeholder = PROVIDERS[providerKey].placeholder;
}

function handleProviderChange() {
  const providerKey = providerSelect.value;
  populateModels(providerKey);
  loadSavedKey(providerKey);
}

function togglePasswordVisibility() {
  const isPassword = apiKeyInput.type === "password";
  apiKeyInput.type = isPassword ? "text" : "password";
  
  if (isPassword) {
    eyeIcon.innerHTML = `
      <path d="M12 7c-2.76 0-5 2.24-5 5s2.24 5 5 5 5-2.24 5-5-2.24-5-5-5zm0 8.5c-1.93 0-3.5-1.57-3.5-3.5s1.57-3.5 3.5-3.5 3.5 1.57 3.5 3.5-1.57 3.5-3.5 3.5z"/>
      <path d="M12 4.5C7 4.5 2.73 7.61 1 12c1.04 2.63 3.14 4.8 5.77 6.13l1.45-1.45C6.12 15.52 4.41 13.88 3.16 12c1.47-3.32 4.84-5.5 8.84-5.5.99 0 1.94.13 2.85.38l1.47-1.47C14.97 4.86 13.52 4.5 12 4.5zM22.06 18.06l-2.06-2.06L6.94 2.94 4.88 4.88l2.56 2.56L1 12c1.73 4.39 6 7.5 11 7.5 1.52 0 2.97-.36 4.32-.91l3.86 3.86 2.06-2.06zM12 17c-2.76 0-5-2.24-5-5 0-.25.04-.49.09-.73l6.64 6.64c-.24.05-.48.09-.73.09z"/>
    `;
  } else {
    eyeIcon.innerHTML = `
      <path d="M12 4.5C7 4.5 2.73 7.61 1 12c1.73 4.39 6 7.5 11 7.5s9.27-3.11 11-7.5c-1.73-4.39-6-7.5-11-7.5zM12 17c-2.76 0-5-2.24-5-5s2.24-5 5-5 5 2.24 5 5-2.24 5-5 5zm0-8c-1.66 0-3 1.34-3 3s1.34 3 3 3 3-1.34 3-3-1.34-3-3-3z"/>
    `;
  }
}

// ----------------------------------------------------
// Playground Generation Proxy Logic
// ----------------------------------------------------
async function handleGeneration() {
  const provider = providerSelect.value;
  const starApiKey = apiKeyInput.value.trim();
  const model = modelSelect.value;
  const systemText = systemInstruction.value.trim();
  const temp = parseFloat(temperatureSlider.value);
  const maxTokens = maxTokensInput.value.trim() ? parseInt(maxTokensInput.value) : null;
  const prompt = promptInput.value.trim();

  // Guard Clauses
  if (!starApiKey) {
    showToast("Please enter your custom Star AI API Key.", "error");
    apiKeyInput.focus();
    return;
  }
  if (!prompt) {
    showToast("Please write a prompt.", "error");
    promptInput.focus();
    return;
  }

  // Save key status locally
  if (saveKeyCheckbox.checked) {
    if (!profiles[currentProfile]) {
      profiles[currentProfile] = { "gemini": "", "openai": "", "groq": "" };
    }
    profiles[currentProfile][provider] = starApiKey;
    saveProfiles();
  }

  // Set UI state to Loading
  document.body.classList.add("loading");
  submitBtn.disabled = true;
  submitBtnText.textContent = "Routing Query...";

  emptyState.style.display = "none";
  outputContent.style.display = "block";
  outputContent.innerHTML = "<p style='color: var(--text-muted); font-style: italic; display: flex; align-items: center; gap: 8px;'>Contacting gateway server<span class='spinner' style='display:inline-block; border-color:var(--text-muted); border-top-color:var(--primary); width:14px; height:14px;'></span></p>";

  try {
    const response = await fetch('/api/generate', {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-API-Key": starApiKey
      },
      body: JSON.stringify({
        provider,
        model,
        prompt,
        temperature: temp,
        maxTokens,
        systemInstruction: systemText
      })
    });

    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error || "Gateway Server Error");
    }

    rawResponseText = data.text;
    outputContent.innerHTML = parseMarkdown(data.text);
    
    if (data.cached) {
      showToast("Answer fetched instantly from Server Cache!", "success");
    } else {
      showToast("Response generated & logged to Excel!", "success");
    }
    
    outputWindow.scrollTo({ top: 0, behavior: 'smooth' });

  } catch (err) {
    console.error(err);
    outputContent.innerHTML = `<div style="color: #f87171; border: 1px solid rgba(239, 68, 68, 0.2); background: rgba(239, 68, 68, 0.05); padding: 16px; border-radius: 8px;"><strong>Gateway Routing Error:</strong><br>${err.message}</div>`;
    showToast("Generation failed. Check response details.", "error");
  } finally {
    document.body.classList.remove("loading");
    submitBtn.disabled = false;
    submitBtnText.textContent = "Send Gateway Request";
  }
}

// ----------------------------------------------------
// Admin Dashboard Fetch & Update Logic
// ----------------------------------------------------
async function loadDashboardData() {
  try {
    await Promise.all([
      fetchBackendConfig(),
      fetchAPIKeys(),
      fetchStats(),
      fetchLogs()
    ]);
  } catch (err) {
    console.error("Error loading dashboard data:", err);
    showToast("Failed to sync some dashboard items from server.", "error");
  }
}

// 1. Fetch Backend configurations
async function fetchBackendConfig() {
  const res = await fetch("/api/admin/config");
  if (!res.ok) throw new Error("Failed to load backend config");
  const data = await res.json();
  
  // Set placeholders to signify configured states without revealing keys
  configGemini.placeholder = data.geminiConfigured ? "•••••••••••••••• (Configured)" : "Enter Gemini Key";
  configOpenai.placeholder = data.openaiConfigured ? "•••••••••••••••• (Configured)" : "Enter OpenAI Key";
  configGroq.placeholder = data.groqConfigured ? "•••••••••••••••• (Configured)" : "Enter Groq Key";
  
  // Clear values so user doesn't submit stars
  configGemini.value = "";
  configOpenai.value = "";
  configGroq.value = "";

  configGlobalSystem.value = data.globalSystemInstruction || "";
  configCacheEnabled.checked = data.cacheEnabled;
  configCacheTtl.value = (data.cacheTTL / 1000) || 300;
}

// Save backend configurations
async function handleSaveConfig(e) {
  e.preventDefault();
  
  const payload = {
    geminiKey: configGemini.value.trim(),
    openaiKey: configOpenai.value.trim(),
    groqKey: configGroq.value.trim(),
    globalSystemInstruction: configGlobalSystem.value.trim(),
    cacheEnabled: configCacheEnabled.checked,
    cacheTTL: parseInt(configCacheTtl.value) * 1000
  };

  try {
    const res = await fetch("/api/admin/config", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Save configuration failed");

    showToast("Server API Configuration updated!", "success");
    await fetchBackendConfig(); // reload configuration state
  } catch (err) {
    showToast(`Config error: ${err.message}`, "error");
  }
}

// 2. Fetch Star AI Keys list
async function fetchAPIKeys() {
  const res = await fetch("/api/admin/keys");
  if (!res.ok) throw new Error("Failed to list custom API keys");
  const keys = await res.json();

  keysTableBody.innerHTML = "";
  if (keys.length === 0) {
    keysTableBody.innerHTML = `<tr><td colspan="5" style="text-align: center; color: var(--text-muted);">No custom gateway keys. Generate one below!</td></tr>`;
    return;
  }

  keys.forEach(k => {
    const tr = document.createElement("tr");
    
    // Status Badge
    const statusBadge = `<span class="badge badge-${k.status}">${k.status}</span>`;
    
    // Masked Key Copy Block
    const maskKey = "star_..." + k.key.substring(k.key.length - 4);
    
    tr.innerHTML = `
      <td style="font-weight: 500;">${escapeHTML(k.name)}</td>
      <td>
        <div class="key-copy-container">
          <span class="key-masked">${maskKey}</span>
          <button class="btn-table-action btn-table-copy" data-key="${k.key}" title="Copy API Key">
            <svg viewBox="0 0 24 24" style="width: 14px; height: 14px; fill: currentColor;"><path d="M16 1H4c-1.1 0-2 .9-2 2v14h2V3h12V1zm3 4H8c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h11c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2zm0 16H8V7h11v14z"/></svg>
          </button>
        </div>
      </td>
      <td style="font-family: var(--font-mono);">${k.usage}</td>
      <td>
        <label class="switch">
          <input type="checkbox" class="toggle-key-status" data-key="${k.key}" ${k.status === 'active' ? 'checked' : ''}>
          <span class="slider"></span>
        </label>
      </td>
      <td>
        <button class="btn-table-action btn-revoke-key" data-key="${k.key}" title="Revoke Key">
          <svg viewBox="0 0 24 24" style="width: 14px; height: 14px; fill: currentColor;"><path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/></svg>
        </button>
      </td>
    `;
    keysTableBody.appendChild(tr);
  });

  // Attach Table Event Listeners
  document.querySelectorAll(".btn-table-copy").forEach(btn => {
    btn.addEventListener("click", (e) => {
      const fullKey = e.currentTarget.getAttribute("data-key");
      navigator.clipboard.writeText(fullKey)
        .then(() => showToast("Copied Star AI API Key to clipboard!", "success"))
        .catch(() => showToast("Failed to copy key.", "error"));
    });
  });

  document.querySelectorAll(".toggle-key-status").forEach(input => {
    input.addEventListener("change", async (e) => {
      const keyVal = e.target.getAttribute("data-key");
      const active = e.target.checked;
      try {
        const res = await fetch(`/api/admin/keys/${keyVal}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ status: active ? "active" : "inactive" })
        });
        if (!res.ok) throw new Error("Status update failed");
        showToast(`Key status updated to ${active ? "active" : "inactive"}`, "success");
        await fetchAPIKeys(); // Refresh key counts & status
      } catch (err) {
        showToast(err.message, "error");
        e.target.checked = !active; // revert checkbox
      }
    });
  });

  document.querySelectorAll(".btn-revoke-key").forEach(btn => {
    btn.addEventListener("click", async (e) => {
      const keyVal = e.currentTarget.getAttribute("data-key");
      if (confirm("Are you sure you want to revoke this API key? Apps using this key will immediately fail requests.")) {
        try {
          const res = await fetch(`/api/admin/keys/${keyVal}`, { method: "DELETE" });
          if (!res.ok) throw new Error("Revocation failed");
          showToast("API Key successfully revoked.", "success");
          await fetchAPIKeys();
        } catch (err) {
          showToast(err.message, "error");
        }
      }
    });
  });
}

// Generate New Star API Key
async function handleGenerateAPIKey() {
  const name = newKeyNameInput.value.trim();
  if (!name) {
    showToast("Please enter an owner name/identifier.", "error");
    newKeyNameInput.focus();
    return;
  }

  try {
    const res = await fetch("/api/admin/keys", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Key generation failed");

    newKeyNameInput.value = "";
    showToast(`Key generated for: ${data.name}`, "success");
    await fetchAPIKeys();
  } catch (err) {
    showToast(err.message, "error");
  }
}

// 3. Fetch Server Performance Stats
async function fetchStats() {
  const res = await fetch("/api/admin/stats");
  if (!res.ok) throw new Error("Failed to load server stats");
  const data = await res.json();

  statTotalQueries.textContent = data.totalQueries;
  statSuccessRate.textContent = data.successRate;
  statCacheHit.textContent = data.cacheHitRate;
  statAvgTime.textContent = data.avgResponseTime;
}

// 4. Fetch logs and trigger rendering
async function fetchLogs() {
  const res = await fetch("/api/admin/logs");
  if (!res.ok) throw new Error("Failed to load request logs");
  rawLogsData = await res.json();
  filterAndRenderLogs();
}

// Filter and render logs on client
function filterAndRenderLogs() {
  const searchVal = logsSearch.value.trim().toLowerCase();
  const providerFilter = logsProviderFilter.value;

  const filteredLogs = rawLogsData.filter(log => {
    const matchesSearch = !searchVal || 
      (log.query && log.query.toLowerCase().includes(searchVal)) || 
      (log.model && log.model.toLowerCase().includes(searchVal)) || 
      (log.apiKeyName && log.apiKeyName.toLowerCase().includes(searchVal));
    
    const matchesProvider = providerFilter === "all" || log.provider === providerFilter;
    
    return matchesSearch && matchesProvider;
  });

  logsTableBody.innerHTML = "";
  if (filteredLogs.length === 0) {
    logsTableBody.innerHTML = `<tr><td colspan="6" style="text-align: center; color: var(--text-muted); padding: 30px;">No matching log files found.</td></tr>`;
    return;
  }

  filteredLogs.forEach(log => {
    const tr = document.createElement("tr");
    
    const timeStr = formatTime(log.timestamp);
    const keyBadge = `<strong>${escapeHTML(log.apiKeyName)}</strong>`;
    
    // Model Badge
    const modelBadge = `<span class="badge badge-${log.provider}">${log.provider}</span> <div style="font-size:11px; color:var(--text-secondary); margin-top:2px;">${log.model}</div>`;
    
    // Status text
    const statusClass = log.status === 'success' ? 'badge-success' : 'badge-failed';
    const statusText = `<span class="badge ${statusClass}">${log.status}</span>`;
    const cachedBadge = log.cached ? `<span class="badge" style="background:rgba(99,102,241,0.2); color:#a5f3fc; border:1px solid rgba(99,102,241,0.3); margin-top:4px; display:inline-block;">Cached</span>` : '';
    const statsBlock = `
      <div style="font-family:var(--font-mono); font-size:12px;">${log.duration} ms</div>
      ${statusText}
      ${cachedBadge}
    `;

    // Query & Answer Expandable Previews
    const queryEscaped = escapeHTML(log.query);
    const answerEscaped = escapeHTML(log.answer);
    
    tr.innerHTML = `
      <td style="color: var(--text-muted); font-size: 11.5px; font-family:var(--font-mono);">${timeStr}</td>
      <td>${keyBadge}</td>
      <td>${modelBadge}</td>
      <td>
        <div style="max-height:60px; overflow-y:auto; max-width:220px; white-space:pre-wrap; overflow-wrap: break-word; word-break: break-all; font-size:12.5px; color:var(--text-secondary); line-height:1.4;">${queryEscaped}</div>
      </td>
      <td>
        <div style="max-height:80px; overflow-y:auto; max-width:320px; white-space:pre-wrap; overflow-wrap: break-word; word-break: break-all; font-size:12.5px; line-height:1.4; font-family:var(--font-mono);">${answerEscaped}</div>
      </td>
      <td>${statsBlock}</td>
    `;
    logsTableBody.appendChild(tr);
  });
}

// ----------------------------------------------------
// UI Formats & Utility functions
// ----------------------------------------------------
function formatTime(isoStr) {
  if (!isoStr) return "";
  const d = new Date(isoStr);
  
  // Format as: YYYY-MM-DD HH:MM:SS
  const pad = (n) => String(n).padStart(2, '0');
  
  const dateStr = `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;
  const timeStr = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  
  return `${dateStr} ${timeStr}`;
}

function escapeHTML(str) {
  if (!str) return "";
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

// Custom Markdown parsing function (preserved from original app.js)
function parseMarkdown(text) {
  if (!text) return "";
  
  let html = text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
  
  html = html.replace(/```(\w*)\n([\s\S]*?)\n```/g, (match, lang, code) => {
    return `<pre><code class="language-${lang || 'txt'}">${code.trim()}</code></pre>`;
  });
  
  html = html.replace(/`([^`]+)`/g, '<code>$1</code>');
  
  html = html.replace(/^### (.*$)/gim, '<h3>$1</h3>');
  html = html.replace(/^## (.*$)/gim, '<h2>$1</h2>');
  html = html.replace(/^# (.*$)/gim, '<h1>$1</h1>');
  
  html = html.replace(/^\>\s?(.*$)/gim, '<blockquote>$1</blockquote>');
  
  html = html.replace(/^\s*[-*]\s+(.*$)/gim, '<ul><li>$1</li></ul>');
  html = html.replace(/<\/ul>\s*<ul>/g, ''); 
  
  html = html.replace(/^\s*\d+\.\s+(.*$)/gim, '<ol><li>$1</li></ol>');
  html = html.replace(/<\/ol>\s*<ol>/g, ''); 
  
  html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  html = html.replace(/\*([^*]+)\*/g, '<em>$1</em>');
  
  const blocks = html.split(/\n\n+/);
  html = blocks.map(block => {
    const trimmed = block.trim();
    if (!trimmed) return '';
    if (trimmed.startsWith('<h') || trimmed.startsWith('<pre') || trimmed.startsWith('<ul') || trimmed.startsWith('<ol') || trimmed.startsWith('<blockquote')) {
      return trimmed;
    }
    return `<p>${trimmed.replace(/\n/g, '<br>')}</p>`;
  }).join('\n');
  
  return html;
}

function showToast(text, type = "info") {
  if (currentToastTimeout) {
    clearTimeout(currentToastTimeout);
  }
  
  notificationBanner.className = `notification-banner show ${type}`;
  notificationText.textContent = text;
  
  currentToastTimeout = setTimeout(() => {
    notificationBanner.classList.remove("show");
  }, 4000);
}

function clearOutput() {
  rawResponseText = "";
  outputContent.innerHTML = "";
  outputContent.style.display = "none";
  emptyState.style.display = "flex";
  showToast("Output cleared.", "info");
}

function copyOutputToClipboard() {
  if (!rawResponseText) {
    showToast("Nothing to copy!", "error");
    return;
  }
  
  navigator.clipboard.writeText(rawResponseText)
    .then(() => showToast("Copied markdown to clipboard!", "success"))
    .catch(() => showToast("Failed to copy text.", "error"));
}

// Start
document.addEventListener("DOMContentLoaded", init);

// server.js
const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'frontend'))); // Serve client static files

// File paths
const BASE_DIR = path.join(__dirname, '..');
const CONFIG_PATH = path.join(BASE_DIR, 'config', 'config.json');
const KEYS_PATH = path.join(BASE_DIR, 'database', 'api_keys.json');
const LOGS_JSON_PATH = path.join(BASE_DIR, 'database', 'api_logs.json');
const LOGS_CSV_PATH = path.join(BASE_DIR, 'database', 'api_logs.csv');
const CUSTOM_DB_PATH = path.join(BASE_DIR, 'database', 'custom_database.json');

// In-memory cache for queries
// Key: provider_model_temp_prompt_system
// Value: { answer, timestamp }
const queryCache = new Map();

// Helper: Read JSON file safely
function readJSON(filePath, defaultVal = {}) {
  try {
    if (!fs.existsSync(filePath)) {
      fs.writeFileSync(filePath, JSON.stringify(defaultVal, null, 2), 'utf8');
      return defaultVal;
    }
    const content = fs.readFileSync(filePath, 'utf8');
    return JSON.parse(content);
  } catch (err) {
    console.error(`Error reading file ${filePath}:`, err);
    return defaultVal;
  }
}

// Helper: Write JSON file safely
function writeJSON(filePath, data) {
  try {
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
    return true;
  } catch (err) {
    console.error(`Error writing file ${filePath}:`, err);
    return false;
  }
}

// Helper: Escape value for Excel-compatible CSV (RFC 4180)
function escapeCSV(val) {
  if (val === undefined || val === null) return '""';
  let str = String(val);
  // Replace double quotes with two double quotes
  str = str.replace(/"/g, '""');
  // Wrap in double quotes
  return `"${str}"`;
}

// Initialize files if they do not exist
const initialConfig = {
  geminiKey: "",
  openaiKey: "",
  groqKey: "",
  globalSystemInstruction: "You are Star AI, a helpful, advanced, and accurate assistant.",
  cacheEnabled: true,
  cacheTTL: 300000 // 5 minutes in milliseconds
};

const initialKeys = [
  {
    key: "star_key_demo_playground",
    name: "Demo Playground Key",
    status: "active",
    createdAt: new Date().toISOString(),
    usage: 0
  }
];

readJSON(CONFIG_PATH, initialConfig);
readJSON(KEYS_PATH, initialKeys);
readJSON(CUSTOM_DB_PATH, {
  "what is your name": "I am Star AI, your custom-trained intelligent server agent.",
  "what is star ai": "Star AI is an advanced, multi-model proxy and caching gateway built by Star AI Lab.",
  "hello": "Hello! I am Star AI. How can I assist you today?",
  "hi": "Hi there! I am Star AI. How can I help you?"
});

if (!fs.existsSync(LOGS_CSV_PATH)) {
  const headers = ['Timestamp', 'API Key Name', 'Provider', 'Model', 'Query', 'Answer', 'Status', 'Duration (ms)', 'Cached'].map(escapeCSV).join(',') + '\n';
  fs.writeFileSync(LOGS_CSV_PATH, headers, 'utf8');
}
readJSON(LOGS_JSON_PATH, []);

// Helper: Append log entry to both JSON and CSV
function logRequest(apiKeyName, provider, model, query, answer, status, duration, cached) {
  const timestamp = new Date().toISOString();
  
  // 1st copy: Append to CSV (for Excel)
  const csvRow = [
    timestamp,
    apiKeyName,
    provider,
    model,
    query,
    answer,
    status,
    duration,
    cached ? 'Yes' : 'No'
  ].map(escapeCSV).join(',') + '\n';
  
  fs.appendFile(LOGS_CSV_PATH, csvRow, 'utf8', (err) => {
    if (err) console.error("Failed to write to CSV log file:", err);
  });

  // 2nd copy: Append to JSON (for Dashboard UI)
  const logs = readJSON(LOGS_JSON_PATH, []);
  logs.unshift({
    timestamp,
    apiKeyName,
    provider,
    model,
    query: query.substring(0, 1000), // truncate long query for JSON list
    answer: answer ? answer.substring(0, 2000) : "", // truncate long answer
    status,
    duration,
    cached
  });
  
  // Cap JSON logs at 1000 items to save space
  if (logs.length > 1000) logs.pop();
  writeJSON(LOGS_JSON_PATH, logs);
}

// Helper: Search local QA database and successful logs for the exact query
function findLocalAnswer(prompt) {
  if (!prompt) return null;
  const cleanPrompt = String(prompt).trim().toLowerCase();
  
  // 1. Check custom QA database
  const customDb = readJSON(CUSTOM_DB_PATH, {});
  if (customDb[cleanPrompt]) {
    console.log(`[Local Lookup] Found match in custom_database.json for: "${cleanPrompt}"`);
    return { answer: customDb[cleanPrompt], source: "custom_database" };
  }
  
  // 2. Check historical successful queries in api_logs.json
  const logs = readJSON(LOGS_JSON_PATH, []);
  const match = logs.find(l => l.status === 'success' && String(l.query).trim().toLowerCase() === cleanPrompt);
  if (match && match.answer) {
    console.log(`[Local Lookup] Found match in api_logs.json for: "${cleanPrompt}"`);
    return { answer: match.answer, source: "historical_logs" };
  }
  
  return null;
}

// -------------------------------------------------------------------------
// ROUTE: API Gateway Endpoint (POST /api/generate)
// -------------------------------------------------------------------------
const FALLBACK_MODELS = {
  // No deprecated fallbacks to prevent 404 Errors on older models
};

// Helper: Perform the actual LLM API HTTP call
async function executeLLMCall(provider, model, prompt, temperature, maxTokens, systemInstruction, apiKey, serverConfig) {
  if (provider === "gemini") {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
    const finalSystem = systemInstruction || serverConfig.globalSystemInstruction;
    
    const body = {
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { temperature: parseFloat(temperature) }
    };
    
    if (maxTokens) body.generationConfig.maxOutputTokens = parseInt(maxTokens);
    if (finalSystem) body.systemInstruction = { parts: [{ text: finalSystem }] };

    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });
    
    const data = await response.json();
    if (!response.ok) {
      throw new Error(data.error?.message || response.statusText || "Unknown Gemini API Error");
    }
    
    if (data.candidates && data.candidates[0]?.content?.parts?.[0]?.text) {
      return data.candidates[0].content.parts[0].text;
    } else {
      throw new Error("Empty response returned. Request may have triggered safety filters.");
    }
    
  } else if (provider === "openai") {
    const url = "https://api.openai.com/v1/chat/completions";
    const finalSystem = systemInstruction || serverConfig.globalSystemInstruction;
    
    const messages = [];
    if (finalSystem) messages.push({ role: "system", content: finalSystem });
    messages.push({ role: "user", content: prompt });

    const body = {
      model: model,
      messages: messages,
      temperature: parseFloat(temperature)
    };
    
    if (maxTokens) body.max_tokens = parseInt(maxTokens);

    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiKey}`
      },
      body: JSON.stringify(body)
    });

    const data = await response.json();
    if (!response.ok) {
      throw new Error(data.error?.message || response.statusText || "Unknown OpenAI Error");
    }

    if (data.choices && data.choices[0]?.message?.content) {
      return data.choices[0].message.content;
    } else {
      throw new Error("Empty response returned from OpenAI.");
    }

  } else if (provider === "groq") {
    const url = "https://api.groq.com/openai/v1/chat/completions";
    const finalSystem = systemInstruction || serverConfig.globalSystemInstruction;

    const messages = [];
    if (finalSystem) messages.push({ role: "system", content: finalSystem });
    messages.push({ role: "user", content: prompt });

    const body = {
      model: model,
      messages: messages,
      temperature: parseFloat(temperature)
    };

    if (maxTokens) body.max_tokens = parseInt(maxTokens);

    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiKey}`
      },
      body: JSON.stringify(body)
    });

    const data = await response.json();
    if (!response.ok) {
      throw new Error(data.error?.message || response.statusText || "Unknown Groq Error");
    }

    if (data.choices && data.choices[0]?.message?.content) {
      return data.choices[0].message.content;
    } else {
      throw new Error("Empty response returned from Groq.");
    }
  } else {
    throw new Error(`Provider '${provider}' is not supported.`);
  }
}

// Helper: Handle retries and fallback
async function executeLLMWithRetryAndFallback(provider, requestedModel, prompt, temperature, maxTokens, systemInstruction, serverConfig) {
  let keysString = "";
  if (provider === "gemini") {
    keysString = serverConfig.geminiKey || process.env.GEMINI_API_KEY || "";
  } else if (provider === "openai") {
    keysString = serverConfig.openaiKey || process.env.OPENAI_API_KEY || "";
  } else if (provider === "groq") {
    keysString = serverConfig.groqKey || process.env.GROQ_API_KEY || "";
  }

  // Parse comma-separated list of keys
  const apiKeys = keysString.split(',').map(k => k.trim()).filter(k => k.length > 0);
  if (apiKeys.length === 0) {
    throw new Error(`${provider.toUpperCase()} API key is not configured on the server.`);
  }

  let currentModel = requestedModel;

  // Outer loop: iterate through the key list
  for (let kIdx = 0; kIdx < apiKeys.length; kIdx++) {
    const currentKey = apiKeys[kIdx];
    let attempt = 0;
    const maxRetries = 2;
    let delay = 1000;

    console.log(`[Proxy] Attempting LLM call using ${provider} API Key ${kIdx + 1}/${apiKeys.length}...`);

    while (attempt <= maxRetries) {
      try {
        const text = await executeLLMCall(provider, currentModel, prompt, temperature, maxTokens, systemInstruction, currentKey, serverConfig);
        return { text, finalModel: currentModel };
      } catch (err) {
        const errMsg = err.message || "";
        const isTemporary = errMsg.toLowerCase().includes("high demand") ||
                            errMsg.toLowerCase().includes("overloaded") ||
                            errMsg.toLowerCase().includes("spikes in demand") ||
                            errMsg.toLowerCase().includes("try again later") ||
                            errMsg.toLowerCase().includes("rate limit") ||
                            errMsg.toLowerCase().includes("quota") ||
                            errMsg.toLowerCase().includes("limit") ||
                            errMsg.toLowerCase().includes("429") ||
                            errMsg.toLowerCase().includes("503");

        if (isTemporary && attempt < maxRetries) {
          attempt++;
          console.warn(`[Proxy] Key ${kIdx + 1} busy. Retrying in ${delay}ms... (Attempt ${attempt}/${maxRetries})`);
          await new Promise(resolve => setTimeout(resolve, delay));
          delay *= 2; // exponential backoff
          continue;
        }

        // If this key failed all retries, rotate to the next key if we have more
        if (kIdx < apiKeys.length - 1) {
          console.warn(`[Rotation] Key ${kIdx + 1} failed/exhausted. Rotating to Key ${kIdx + 2}...`);
          break; // break inner loop, continue outer loop
        }

        // If it's the last key, try alternate model failover
        const fallback = FALLBACK_MODELS[currentModel];
        if (fallback) {
          console.warn(`[Proxy] Model ${currentModel} busy and all keys exhausted. Falling back to ${fallback}...`);
          currentModel = fallback;
          kIdx = -1; // reset key index to start from first key again for fallback model
          break; // break inner loop to restart key rotation
        }

        // Throw final error if all keys failed and no fallback available
        throw err;
      }
    }
  }
}

app.post('/api/generate', async (req, res) => {
  const start = Date.now();
  const clientApiKey = req.headers['x-api-key'];
  
  if (!clientApiKey) {
    return res.status(401).json({ error: "Missing x-api-key header. Please generate and provide a Star AI API key." });
  }

  // Validate API key
  const keys = readJSON(KEYS_PATH, []);
  const keyObj = keys.find(k => k.key === clientApiKey);
  
  if (!keyObj) {
    return res.status(401).json({ error: "Invalid API key. Check your Server Dashboard to manage API keys." });
  }
  if (keyObj.status !== 'active') {
    return res.status(403).json({ error: "This API key has been deactivated." });
  }

  const { provider, model, prompt, temperature = 0.7, maxTokens, systemInstruction } = req.body;

  if (!prompt) {
    return res.status(400).json({ error: "Missing 'prompt' parameter in request body." });
  }

  const serverConfig = readJSON(CONFIG_PATH, initialConfig);
  
  // 1. Check custom database & query history first (Intelligent Agent behavior)
  const localMatch = findLocalAnswer(prompt);
  if (localMatch) {
    const duration = Date.now() - start;
    
    // Increment key usage
    keyObj.usage += 1;
    writeJSON(KEYS_PATH, keys);

    // Log request (cached = true, model indicates local lookup source)
    logRequest(keyObj.name, provider, `${model} (Local DB)`, prompt, localMatch.answer, "success", duration, true);

    return res.json({ text: localMatch.answer, cached: true });
  }

  // Build cache key for regular query caching
  const cacheKey = `${provider}_${model}_${temperature}_${prompt}_${systemInstruction || ''}_${serverConfig.globalSystemInstruction || ''}`;

  // Check cache if enabled
  if (serverConfig.cacheEnabled) {
    const cachedEntry = queryCache.get(cacheKey);
    if (cachedEntry && (Date.now() - cachedEntry.timestamp < serverConfig.cacheTTL)) {
      const duration = Date.now() - start;
      
      keyObj.usage += 1;
      writeJSON(KEYS_PATH, keys);

      // Log hit
      logRequest(keyObj.name, provider, model, prompt, cachedEntry.answer, "success", duration, true);

      return res.json({ text: cachedEntry.answer, cached: true });
    }
  }

  // Route request with retry & fallback mechanism
  try {
    const { text, finalModel } = await executeLLMWithRetryAndFallback(
      provider,
      model,
      prompt,
      temperature,
      maxTokens,
      systemInstruction,
      serverConfig
    );

    const duration = Date.now() - start;

    // Cache result if enabled
    if (serverConfig.cacheEnabled) {
      queryCache.set(cacheKey, {
        answer: text,
        timestamp: Date.now()
      });
    }

    // Increment usage
    keyObj.usage += 1;
    writeJSON(KEYS_PATH, keys);

    // Save logs (uses the finalModel in case of fallback failover!)
    logRequest(keyObj.name, provider, finalModel, prompt, text, "success", duration, false);

    // Send response
    res.json({ text, cached: false });

  } catch (err) {
    const duration = Date.now() - start;
    
    // Graceful user-facing error notice, hiding raw tracebacks
    const friendlyError = "The server is currently experiencing high demand. Please try again in a few moments.";
    
    // Still log the raw error on the server for debugging
    logRequest(keyObj.name, provider, model, prompt, `Error: ${err.message}`, "failed", duration, false);
    
    console.error("Gateway Forward Error:", err);
    res.status(500).json({ error: friendlyError });
  }
});


// -------------------------------------------------------------------------
// ADMIN ROUTES: Key Management
// -------------------------------------------------------------------------
app.get('/api/admin/keys', (req, res) => {
  const keys = readJSON(KEYS_PATH, []);
  res.json(keys);
});

app.post('/api/admin/keys', (req, res) => {
  const { name } = req.body;
  if (!name || !name.trim()) {
    return res.status(400).json({ error: "Key name/description is required." });
  }
  
  const randomHex = Math.random().toString(16).substring(2, 10) + Math.random().toString(16).substring(2, 10);
  const newKey = `star_key_${randomHex}`;
  
  const keys = readJSON(KEYS_PATH, []);
  const newKeyObj = {
    key: newKey,
    name: name.trim(),
    status: "active",
    createdAt: new Date().toISOString(),
    usage: 0
  };
  
  keys.push(newKeyObj);
  writeJSON(KEYS_PATH, keys);
  res.json(newKeyObj);
});

app.delete('/api/admin/keys/:key', (req, res) => {
  const keyToRevoke = req.params.key;
  let keys = readJSON(KEYS_PATH, []);
  
  const exists = keys.some(k => k.key === keyToRevoke);
  if (!exists) {
    return res.status(404).json({ error: "API Key not found." });
  }
  
  keys = keys.filter(k => k.key !== keyToRevoke);
  writeJSON(KEYS_PATH, keys);
  res.json({ success: true, message: "API key revoked successfully." });
});

app.put('/api/admin/keys/:key', (req, res) => {
  const keyToUpdate = req.params.key;
  const { status } = req.body;
  
  const keys = readJSON(KEYS_PATH, []);
  const keyObj = keys.find(k => k.key === keyToUpdate);
  
  if (!keyObj) {
    return res.status(404).json({ error: "API Key not found." });
  }
  
  if (status) {
    keyObj.status = status; // active or inactive
  }
  
  writeJSON(KEYS_PATH, keys);
  res.json(keyObj);
});


// -------------------------------------------------------------------------
// ADMIN ROUTES: Configuration Management
// -------------------------------------------------------------------------
app.get('/api/admin/config', (req, res) => {
  const config = readJSON(CONFIG_PATH, initialConfig);
  // Return masked keys for security
  res.json({
    geminiConfigured: !!config.geminiKey,
    openaiConfigured: !!config.openaiKey,
    groqConfigured: !!config.groqKey,
    globalSystemInstruction: config.globalSystemInstruction || "",
    cacheEnabled: config.cacheEnabled !== false,
    cacheTTL: config.cacheTTL || 300000
  });
});

app.post('/api/admin/config', (req, res) => {
  const { geminiKey, openaiKey, groqKey, globalSystemInstruction, cacheEnabled, cacheTTL } = req.body;
  const config = readJSON(CONFIG_PATH, initialConfig);
  
  // Only update keys if sent and not masked/empty
  if (geminiKey !== undefined && geminiKey.trim() !== "" && !geminiKey.includes("••••")) {
    config.geminiKey = geminiKey.trim();
  }
  if (openaiKey !== undefined && openaiKey.trim() !== "" && !openaiKey.includes("••••")) {
    config.openaiKey = openaiKey.trim();
  }
  if (groqKey !== undefined && groqKey.trim() !== "" && !groqKey.includes("••••")) {
    config.groqKey = groqKey.trim();
  }
  
  if (globalSystemInstruction !== undefined) {
    config.globalSystemInstruction = globalSystemInstruction.trim();
  }
  if (cacheEnabled !== undefined) {
    config.cacheEnabled = !!cacheEnabled;
  }
  if (cacheTTL !== undefined) {
    config.cacheTTL = parseInt(cacheTTL) || 300000;
  }
  
  writeJSON(CONFIG_PATH, config);
  
  res.json({
    success: true,
    message: "Configuration saved successfully.",
    config: {
      geminiConfigured: !!config.geminiKey,
      openaiConfigured: !!config.openaiKey,
      groqConfigured: !!config.groqKey,
      globalSystemInstruction: config.globalSystemInstruction,
      cacheEnabled: config.cacheEnabled,
      cacheTTL: config.cacheTTL
    }
  });
});


// -------------------------------------------------------------------------
// ADMIN ROUTES: Logs & Stats
// -------------------------------------------------------------------------
app.get('/api/admin/logs', (req, res) => {
  const logs = readJSON(LOGS_JSON_PATH, []);
  res.json(logs);
});

app.get('/api/admin/logs/download', (req, res) => {
  if (!fs.existsSync(LOGS_CSV_PATH)) {
    return res.status(404).send("Logs file is empty or not initialized.");
  }
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename=star_ai_api_logs.csv');
  
  const stream = fs.createReadStream(LOGS_CSV_PATH);
  stream.pipe(res);
});

app.get('/api/admin/stats', (req, res) => {
  const logs = readJSON(LOGS_JSON_PATH, []);
  const keys = readJSON(KEYS_PATH, []);
  
  const total = logs.length;
  const success = logs.filter(l => l.status === 'success').length;
  const cached = logs.filter(l => l.cached).length;
  const failed = total - success;
  
  const cacheHitRate = total > 0 ? ((cached / total) * 100).toFixed(1) : "0.0";
  const successRate = total > 0 ? ((success / total) * 100).toFixed(1) : "100.0";
  
  // Calculate average duration of non-cached successful requests
  const nonCachedSuccess = logs.filter(l => l.status === 'success' && !l.cached);
  const avgDuration = nonCachedSuccess.length > 0
    ? (nonCachedSuccess.reduce((acc, l) => acc + l.duration, 0) / nonCachedSuccess.length).toFixed(0)
    : "0";

  // Requests by provider
  const providerStats = logs.reduce((acc, l) => {
    acc[l.provider] = (acc[l.provider] || 0) + 1;
    return acc;
  }, {});

  res.json({
    totalQueries: total,
    successRate: `${successRate}%`,
    cacheHitRate: `${cacheHitRate}%`,
    avgResponseTime: `${avgDuration} ms`,
    failedQueries: failed,
    activeKeys: keys.filter(k => k.status === 'active').length,
    providerStats
  });
});

app.listen(PORT, () => {
  console.log(`====================================================`);
  console.log(`STAR AI GATEWAY SERVER RUNNING ON PORT ${PORT}`);
  console.log(`Access local dashboard: http://localhost:${PORT}`);
  console.log(`====================================================`);
});

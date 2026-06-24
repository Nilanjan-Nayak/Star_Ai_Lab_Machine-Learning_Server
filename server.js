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
app.use(express.static(__dirname)); // Serve client static files

// File paths
const CONFIG_PATH = path.join(__dirname, 'config.json');
const KEYS_PATH = path.join(__dirname, 'api_keys.json');
const LOGS_JSON_PATH = path.join(__dirname, 'api_logs.json');
const LOGS_CSV_PATH = path.join(__dirname, 'api_logs.csv');

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

// -------------------------------------------------------------------------
// ROUTE: API Gateway Endpoint (POST /api/generate)
// -------------------------------------------------------------------------
const FALLBACK_MODELS = {
  "gemini-2.5-flash": "gemini-1.5-flash",
  "gemini-2.5-pro": "gemini-1.5-pro",
  "gpt-4o-mini": "gpt-3.5-turbo",
  "llama-3.3-70b-versatile": "llama-3.1-8b-instant"
};

// Helper: Perform the actual LLM API HTTP call
async function executeLLMCall(provider, model, prompt, temperature, maxTokens, systemInstruction, serverConfig) {
  if (provider === "gemini") {
    const geminiKey = serverConfig.geminiKey || process.env.GEMINI_API_KEY;
    if (!geminiKey) throw new Error("Gemini API key is not configured on the server.");
    
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${geminiKey}`;
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
    const openaiKey = serverConfig.openaiKey || process.env.OPENAI_API_KEY;
    if (!openaiKey) throw new Error("OpenAI API key is not configured on the server.");
    
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
        "Authorization": `Bearer ${openaiKey}`
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
    const groqKey = serverConfig.groqKey || process.env.GROQ_API_KEY;
    if (!groqKey) throw new Error("Groq API key is not configured on the server.");

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
        "Authorization": `Bearer ${groqKey}`
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
  let currentModel = requestedModel;
  let attempt = 0;
  const maxRetries = 2;
  let delay = 1000;
  
  while (true) {
    try {
      const text = await executeLLMCall(provider, currentModel, prompt, temperature, maxTokens, systemInstruction, serverConfig);
      return { text, finalModel: currentModel };
    } catch (err) {
      const errMsg = err.message || "";
      const isTemporary = errMsg.toLowerCase().includes("high demand") ||
                          errMsg.toLowerCase().includes("overloaded") ||
                          errMsg.toLowerCase().includes("spikes in demand") ||
                          errMsg.toLowerCase().includes("try again later") ||
                          errMsg.toLowerCase().includes("rate limit") ||
                          errMsg.toLowerCase().includes("429") ||
                          errMsg.toLowerCase().includes("503");
                          
      if (isTemporary) {
        if (attempt < maxRetries) {
          attempt++;
          console.warn(`[Proxy] Model ${currentModel} busy. Retrying in ${delay}ms... (Attempt ${attempt}/${maxRetries})`);
          await new Promise(resolve => setTimeout(resolve, delay));
          delay *= 2; // exponential backoff
          continue;
        }
        
        // Retries failed, try fallback
        const fallback = FALLBACK_MODELS[currentModel];
        if (fallback) {
          console.warn(`[Proxy] Model ${currentModel} busy and failed after retries. Falling back to ${fallback}...`);
          currentModel = fallback;
          attempt = 0;
          delay = 1000;
          continue;
        }
      }
      
      throw err;
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
  
  // Build cache key
  const cacheKey = `${provider}_${model}_${temperature}_${prompt}_${systemInstruction || ''}_${serverConfig.globalSystemInstruction || ''}`;

  // Check cache if enabled
  if (serverConfig.cacheEnabled) {
    const cachedEntry = queryCache.get(cacheKey);
    if (cachedEntry && (Date.now() - cachedEntry.timestamp < serverConfig.cacheTTL)) {
      const duration = Date.now() - start;
      // Increment key usage
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

    // Increment usage & save key registry
    keyObj.usage += 1;
    writeJSON(KEYS_PATH, keys);

    // Save logs (uses the finalModel in case of fallback failover!)
    logRequest(keyObj.name, provider, finalModel, prompt, text, "success", duration, false);

    // Send response (2nd copy)
    res.json({ text: text, cached: false });

  } catch (err) {
    const duration = Date.now() - start;
    logRequest(keyObj.name, provider, model, prompt, err.message, "failed", duration, false);
    
    console.error("Gateway Forward Error:", err);
    res.status(500).json({ error: err.message });
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

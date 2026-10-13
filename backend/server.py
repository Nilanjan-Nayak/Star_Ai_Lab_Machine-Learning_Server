# server.py
import os
import json
import time
import secrets
import httpx
import asyncio
import threading
from datetime import datetime, timezone
from datetime import timedelta
from typing import Optional, Dict, Any, List
from fastapi import FastAPI, Header, HTTPException, Request, Response, status
from fastapi.responses import FileResponse, JSONResponse
from fastapi.middleware.cors import CORSMiddleware
from fastapi.exceptions import RequestValidationError
from starlette.exceptions import HTTPException as StarletteHTTPException
from pydantic import BaseModel
import sys

# Ensure project root is in sys.path
BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if BASE_DIR not in sys.path:
    sys.path.insert(0, BASE_DIR)

from dotenv import load_dotenv
from backend.agents.demo_agent import chat_with_agent

try:
    from google.oauth2 import service_account
    from googleapiclient.discovery import build
    from googleapiclient.http import MediaFileUpload
except ImportError:
    service_account = None
    build = None
    MediaFileUpload = None

load_dotenv()


app = FastAPI(
    title="Star AI Gateway API",
    description="FastAPI Backend for Star AI Gateway Server",
    version="1.0.0"
)

# Custom Exception Handlers for client-side compatibility
@app.exception_handler(StarletteHTTPException)
async def http_exception_handler(request: Request, exc: StarletteHTTPException):
    return JSONResponse(
        status_code=exc.status_code,
        content={"error": exc.detail}
    )

@app.exception_handler(RequestValidationError)
async def validation_exception_handler(request: Request, exc: RequestValidationError):
    errors = []
    for err in exc.errors():
        loc = " -> ".join(str(l) for l in err["loc"])
        msg = err["msg"]
        errors.append(f"{loc}: {msg}")
    return JSONResponse(
        status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
        content={"error": "; ".join(errors)}
    )

# Enable CORS
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# File Paths
BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CONFIG_PATH = os.path.join(BASE_DIR, 'config', 'config.json')
KEYS_PATH = os.path.join(BASE_DIR, 'database', 'api_keys.json')
LOGS_JSON_PATH = os.path.join(BASE_DIR, 'database', 'api_logs.json')
LOGS_CSV_PATH = os.path.join(BASE_DIR, 'database', 'api_logs.csv')
CUSTOM_DB_PATH = os.path.join(BASE_DIR, 'database', 'custom_database.json')
LOG_ARCHIVE_DIR = os.path.join(BASE_DIR, 'database', 'log_archives')
LOG_ROTATION_STATE_PATH = os.path.join(BASE_DIR, 'database', 'log_rotation.json')
DRIVE_SYNC_STATE_PATH = os.path.join(BASE_DIR, 'database', 'drive_sync.json')
GOOGLE_DRIVE_FOLDER_ID = os.getenv('GOOGLE_DRIVE_FOLDER_ID', '12-VtHb831npQHPkAhMv-vozL-MPKGscD')
LOG_ROTATION_DAYS = 20
LOG_ROTATION_LOCK = threading.Lock()

os.makedirs(os.path.dirname(CONFIG_PATH), exist_ok=True)
os.makedirs(LOG_ARCHIVE_DIR, exist_ok=True)

# In-memory query cache
# Key: provider_model_temp_prompt_system
# Value: { "answer": str, "timestamp": float }
query_cache: Dict[str, Dict[str, Any]] = {}

# Initial Configurations
initial_config = {
    "geminiKey": "",
    "openaiKey": "",
    "groqKey": "",
    "globalSystemInstruction": "You are Star AI, a helpful, advanced, and accurate assistant.",
    "cacheEnabled": True,
    "cacheTTL": 300000  # 5 minutes in milliseconds
}

# Helper: Get current UTC timestamp in ISO 8601 format with Z suffix
def get_utc_iso() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")

initial_keys = [
    {
        "key": "star_key_demo_playground",
        "name": "Demo Playground Key",
        "status": "active",
        "createdAt": get_utc_iso(),
        "usage": 0
    }
]

# Helper: Read JSON file safely
def read_json(file_path: str, default_val: Any) -> Any:
    try:
        if not os.path.exists(file_path):
            write_json(file_path, default_val)
            return default_val
        with open(file_path, 'r', encoding='utf-8') as f:
            content = f.read().strip()
            if not content:
                return default_val
            return json.loads(content)
    except Exception as e:
        print(f"Error reading file {file_path}: {e}")
        return default_val

# Helper: Write JSON file safely
def write_json(file_path: str, data: Any) -> bool:
    try:
        with open(file_path, 'w', encoding='utf-8') as f:
            json.dump(data, f, indent=2, ensure_ascii=False)
        return True
    except Exception as e:
        print(f"Error writing file {file_path}: {e}")
        return False

# Helper: Escape value for Excel-compatible CSV (RFC 4180)
def escape_csv(val: Any) -> str:
    if val is None:
        return '""'
    s = str(val)
    s = s.replace('"', '""')
    return f'"{s}"'

# Initialize files
read_json(CONFIG_PATH, initial_config)
read_json(KEYS_PATH, initial_keys)
read_json(CUSTOM_DB_PATH, {
    "what is your name": "I am Star AI, your custom-trained intelligent server agent.",
    "what is star ai": "Star AI is an advanced, multi-model proxy and caching gateway built by Star AI Lab.",
    "hello": "Hello! I am Star AI. How can I assist you today?",
    "hi": "Hi there! I am Star AI. How can I help you?"
})

if not os.path.exists(LOGS_CSV_PATH):
    headers = ['Timestamp', 'API Key Name', 'Provider', 'Model', 'Query', 'Answer', 'Status', 'Duration (ms)', 'Cached']
    csv_headers = ",".join(escape_csv(h) for h in headers) + "\n"
    with open(LOGS_CSV_PATH, 'w', encoding='utf-8') as f:
        f.write(csv_headers)

read_json(LOGS_JSON_PATH, [])
if not os.path.exists(LOG_ROTATION_STATE_PATH):
    write_json(LOG_ROTATION_STATE_PATH, {"periodStartedAt": get_utc_iso()})


def reset_csv_log() -> None:
    headers = ['Timestamp', 'API Key Name', 'Provider', 'Model', 'Query', 'Answer', 'Status', 'Duration (ms)', 'Cached']
    csv_headers = ",".join(escape_csv(h) for h in headers) + "\n"
    with open(LOGS_CSV_PATH, 'w', encoding='utf-8') as f:
        f.write(csv_headers)


def rotate_logs_if_due() -> None:
    with LOG_ROTATION_LOCK:
        state = read_json(LOG_ROTATION_STATE_PATH, {"periodStartedAt": get_utc_iso()})
        started_at = state.get("periodStartedAt")
        try:
            period_started = datetime.fromisoformat(str(started_at).replace("Z", "+00:00"))
        except (TypeError, ValueError):
            period_started = datetime.now(timezone.utc)

        now = datetime.now(timezone.utc)
        if now - period_started < timedelta(days=LOG_ROTATION_DAYS):
            return

        logs = read_json(LOGS_JSON_PATH, [])
        if logs:
            archive_name = f"routed_query_logs_{period_started.strftime('%Y%m%d')}_{now.strftime('%Y%m%d')}.json"
            archive_path = os.path.join(LOG_ARCHIVE_DIR, archive_name)
            if write_json(archive_path, logs):
                upload_archive_to_google_drive(archive_path)

        write_json(LOGS_JSON_PATH, [])
        reset_csv_log()
        write_json(LOG_ROTATION_STATE_PATH, {"periodStartedAt": get_utc_iso()})


def upload_archive_to_google_drive(archive_path: str) -> bool:
    if not service_account or not build or not MediaFileUpload:
        return False

    credentials_path = os.getenv('GOOGLE_APPLICATION_CREDENTIALS')
    credentials_json = os.getenv('GOOGLE_SERVICE_ACCOUNT_JSON')
    if not credentials_path and not credentials_json:
        return False

    try:
        scopes = ['https://www.googleapis.com/auth/drive.file']
        if credentials_json:
            credentials = service_account.Credentials.from_service_account_info(
                json.loads(credentials_json), scopes=scopes
            )
        else:
            credentials = service_account.Credentials.from_service_account_file(
                credentials_path, scopes=scopes
            )

        drive = build('drive', 'v3', credentials=credentials, cache_discovery=False)
        metadata = {
            'name': os.path.basename(archive_path),
            'parents': [GOOGLE_DRIVE_FOLDER_ID]
        }
        media = MediaFileUpload(archive_path, mimetype='application/json')
        result = drive.files().create(
            body=metadata,
            media_body=media,
            fields='id,name,webViewLink'
        ).execute()

        sync_state = read_json(DRIVE_SYNC_STATE_PATH, {"uploaded": {}})
        sync_state.setdefault('uploaded', {})[os.path.basename(archive_path)] = result.get('id')
        write_json(DRIVE_SYNC_STATE_PATH, sync_state)
        print(f"[Google Drive] Uploaded {result.get('name')} to the configured folder.")
        return True
    except Exception as e:
        print(f"[Google Drive] Upload skipped: {e}")
        return False


def sync_pending_drive_archives() -> None:
    sync_state = read_json(DRIVE_SYNC_STATE_PATH, {"uploaded": {}})
    uploaded = sync_state.get('uploaded', {})
    for filename in os.listdir(LOG_ARCHIVE_DIR):
        if filename.endswith('.json') and filename not in uploaded:
            upload_archive_to_google_drive(os.path.join(LOG_ARCHIVE_DIR, filename))

# Helper: Search local QA database and successful logs for the exact query
def find_local_answer(prompt: str) -> Optional[Dict[str, str]]:
    if not prompt:
        return None
    clean_prompt = str(prompt).strip().lower()
    
    # 1. Check custom QA database
    custom_db = read_json(CUSTOM_DB_PATH, {})
    if clean_prompt in custom_db:
        print(f"[Local Lookup] Found match in custom_database.json for: \"{clean_prompt}\"")
        return {"answer": custom_db[clean_prompt], "source": "custom_database"}
        
    # 2. Check historical successful queries in api_logs.json
    logs = read_json(LOGS_JSON_PATH, [])
    for log in logs:
        if log.get("status") == "success" and str(log.get("query", "")).strip().lower() == clean_prompt:
            ans = log.get("answer")
            if ans:
                print(f"[Local Lookup] Found match in api_logs.json for: \"{clean_prompt}\"")
                return {"answer": ans, "source": "historical_logs"}
                
    return None

# Helper: Log request to both JSON and CSV
def log_request(api_key_name: str, provider: str, model: str, query: str, answer: str, status_str: str, duration: int, cached: bool):
    rotate_logs_if_due()
    timestamp = get_utc_iso()
    
    # 1. Append to CSV
    row = [
        timestamp,
        api_key_name,
        provider,
        model,
        query,
        answer,
        status_str,
        duration,
        "Yes" if cached else "No"
    ]
    csv_row = ",".join(escape_csv(val) for val in row) + "\n"
    try:
        with open(LOGS_CSV_PATH, 'a', encoding='utf-8') as f:
            f.write(csv_row)
    except Exception as e:
        print(f"Failed to write to CSV log file: {e}")
        
    # 2. Append to JSON
    logs = read_json(LOGS_JSON_PATH, [])
    logs.insert(0, {
        "timestamp": timestamp,
        "apiKeyName": api_key_name,
        "provider": provider,
        "model": model,
        "query": query[:1000] if query else "",
        "answer": answer[:2000] if answer else "",
        "status": status_str,
        "duration": duration,
        "cached": cached
    })
    
    # Cap JSON logs at 1000 items
    if len(logs) > 1000:
        logs = logs[:1000]
    write_json(LOGS_JSON_PATH, logs)

# Fallback Models Map to provide high reliability under high demand (Deprecated maps cleared to prevent 404s)
FALLBACK_MODELS = {}

class GenerateRequest(BaseModel):
    provider: str
    model: str
    prompt: str
    temperature: float = 0.7
    maxTokens: Optional[int] = None
    systemInstruction: Optional[str] = None

# Helper: Perform the actual LLM API HTTP call
def get_api_keys_for_provider(provider: str, server_config: Dict[str, Any]) -> List[str]:
    keys_str = ""
    if provider == "gemini":
        keys_str = server_config.get("geminiKey") or os.getenv("GEMINI_API_KEY") or ""
    elif provider == "openai":
        keys_str = server_config.get("openaiKey") or os.getenv("OPENAI_API_KEY") or ""
    elif provider == "groq":
        keys_str = server_config.get("groqKey") or os.getenv("GROQ_API_KEY") or ""
        
    return [k.strip() for k in keys_str.split(",") if k.strip()]

# Helper: Perform the actual LLM API HTTP call
async def execute_llm_call(
    provider: str,
    model: str,
    prompt: str,
    temperature: float,
    max_tokens: Optional[int],
    system_instruction: Optional[str],
    api_key: str,
    server_config: Dict[str, Any]
) -> str:
    async with httpx.AsyncClient(timeout=60.0) as client:
        if provider == "gemini":
            url = f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent?key={api_key}"
            final_system = system_instruction or server_config.get("globalSystemInstruction")
            
            body = {
                "contents": [{"parts": [{"text": prompt}]}],
                "generationConfig": {"temperature": float(temperature)}
            }
            if max_tokens:
                body["generationConfig"]["maxOutputTokens"] = int(max_tokens)
            if final_system:
                body["systemInstruction"] = {"parts": [{"text": final_system}]}
                
            response = await client.post(url, json=body, headers={"Content-Type": "application/json"})
            data = response.json()
            
            if response.status_code != 200:
                error_msg = data.get("error", {}).get("message") or response.reason_phrase or "Unknown Gemini API Error"
                raise Exception(error_msg)
                
            try:
                text = data["candidates"][0]["content"]["parts"][0]["text"]
                return text
            except (KeyError, IndexError):
                raise Exception("Empty response returned. Request may have triggered safety filters.")
                
        elif provider == "openai":
            url = "https://api.openai.com/v1/chat/completions"
            final_system = system_instruction or server_config.get("globalSystemInstruction")
            
            messages = []
            if final_system:
                messages.append({"role": "system", "content": final_system})
            messages.append({"role": "user", "content": prompt})
            
            body = {
                "model": model,
                "messages": messages,
                "temperature": float(temperature)
            }
            if max_tokens:
                body["max_tokens"] = int(max_tokens)
                
            headers = {
                "Content-Type": "application/json",
                "Authorization": f"Bearer {api_key}"
            }
            
            response = await client.post(url, json=body, headers=headers)
            data = response.json()
            
            if response.status_code != 200:
                error_msg = data.get("error", {}).get("message") or response.reason_phrase or "Unknown OpenAI Error"
                raise Exception(error_msg)
                
            try:
                text = data["choices"][0]["message"]["content"]
                return text
            except (KeyError, IndexError):
                raise Exception("Empty response returned from OpenAI.")
                
        elif provider == "groq":
            url = "https://api.groq.com/openai/v1/chat/completions"
            final_system = system_instruction or server_config.get("globalSystemInstruction")
            
            messages = []
            if final_system:
                messages.append({"role": "system", "content": final_system})
            messages.append({"role": "user", "content": prompt})
            
            body = {
                "model": model,
                "messages": messages,
                "temperature": float(temperature)
            }
            if max_tokens:
                body["max_tokens"] = int(max_tokens)
                
            headers = {
                "Content-Type": "application/json",
                "Authorization": f"Bearer {api_key}"
            }
            
            response = await client.post(url, json=body, headers=headers)
            data = response.json()
            
            if response.status_code != 200:
                error_msg = data.get("error", {}).get("message") or response.reason_phrase or "Unknown Groq Error"
                raise Exception(error_msg)
                
            try:
                text = data["choices"][0]["message"]["content"]
                return text
            except (KeyError, IndexError):
                raise Exception("Empty response returned from Groq.")
        else:
            raise Exception(f"Provider '{provider}' is not supported.")

# Helper: Handle retries, key rotation, and fallback
async def execute_llm_with_retry_and_fallback(
    provider: str,
    requested_model: str,
    prompt: str,
    temperature: float,
    max_tokens: Optional[int],
    system_instruction: Optional[str],
    server_config: Dict[str, Any]
) -> Dict[str, str]:
    current_provider = provider
    current_model = requested_model
    
    while True:
        api_keys = get_api_keys_for_provider(current_provider, server_config)
        if not api_keys:
            raise Exception(f"{current_provider.upper()} API key is not configured on the server.")
            
        fallback_triggered = False
        last_error = Exception(f"No active API keys found for {current_provider}")
        
        for k_idx, current_key in enumerate(api_keys):
            attempt = 0
            max_retries = 2
            delay = 1.0
            
            print(f"[Proxy] Attempting {current_provider}/{current_model} call using Key {k_idx + 1}/{len(api_keys)}...")
            
            key_failed = False
            while attempt <= max_retries:
                try:
                    text = await execute_llm_call(
                        current_provider,
                        current_model,
                        prompt,
                        temperature,
                        max_tokens,
                        system_instruction,
                        current_key,
                        server_config
                    )
                    return {
                        "text": text,
                        "finalModel": current_model,
                        "finalProvider": current_provider
                    }
                except Exception as err:
                    err_msg = str(err)
                    is_temporary = any(term in err_msg.lower() for term in [
                        "high demand", "overloaded", "spikes in demand",
                        "try again later", "rate limit", "429", "503", "quota", "limit"
                    ])
                    
                    if is_temporary and attempt < max_retries:
                        attempt += 1
                        print(f"[Proxy] Key {k_idx + 1} busy. Retrying in {delay}s... (Attempt {attempt}/{max_retries})")
                        await asyncio.sleep(delay)
                        delay *= 2.0
                        continue
                    
                    key_failed = True
                    last_error = err
                    break
            
            if key_failed:
                if k_idx < len(api_keys) - 1:
                    print(f"[Rotation] Key {k_idx + 1} failed/exhausted. Rotating to Key {k_idx + 2}...")
                    continue
                else:
                    # All keys exhausted for this model/provider, try sibling fallback
                    fallback_model = FALLBACK_MODELS.get(current_model)
                    if fallback_model:
                        print(f"[Proxy] Model {current_model} busy and all keys exhausted. Sibling fallback to {fallback_model}...")
                        current_model = fallback_model
                        fallback_triggered = True
                        break
                    
                    # Try cross-provider fallback to Gemini if config key is set
                    if current_provider in ["openai", "groq"]:
                        gemini_keys = get_api_keys_for_provider("gemini", server_config)
                        if gemini_keys and current_provider != "gemini":
                            print(f"[Proxy] Sibling and key exhausted. Cross-provider fallback: {current_provider} -> gemini (gemini-2.5-flash)...")
                            current_provider = "gemini"
                            current_model = "gemini-2.5-flash"
                            fallback_triggered = True
                            break
                            
                    # If all keys failed and no fallback possible, raise the last error
                    raise last_error
                    
        # If we finished the key loop without success and fallback was not triggered, we should stop
        if not fallback_triggered:
            break

# -------------------------------------------------------------------------
# ROUTE: API Gateway Endpoint (POST /api/generate)
# -------------------------------------------------------------------------
@app.post("/api/generate")
async def generate(request: GenerateRequest, x_api_key: Optional[str] = Header(None)):
    start_time = time.time()
    
    if not x_api_key:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Missing x-api-key header. Please generate and provide a Star AI API key."
        )
        
    # Validate API Key
    keys = read_json(KEYS_PATH, [])
    key_obj = next((k for k in keys if k["key"] == x_api_key), None)
    
    if not key_obj:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid API key. Check your Server Dashboard to manage API keys."
        )
        
    if key_obj.get("status") != "active":
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="This API key has been deactivated."
        )
        
    server_config = read_json(CONFIG_PATH, initial_config)
    global_system = server_config.get("globalSystemInstruction") or ""
    req_system = request.systemInstruction or ""
    
    # 1. Check custom database & query history first (Intelligent Agent behavior)
    local_match = find_local_answer(request.prompt)
    if local_match:
        duration = int((time.time() - start_time) * 1000)
        
        # Increment usage
        key_obj["usage"] += 1
        write_json(KEYS_PATH, keys)
        
        # Log request
        log_request(
            key_obj["name"],
            request.provider,
            f"{request.model} (Local DB)",
            request.prompt,
            local_match["answer"],
            "success",
            duration,
            True
        )
        
        return {"text": local_match["answer"], "cached": True}
        
    # Build cache key
    cache_key = f"{request.provider}_{request.model}_{request.temperature}_{request.prompt}_{req_system}_{global_system}"
    
    # Check cache if enabled
    if server_config.get("cacheEnabled"):
        cached_entry = query_cache.get(cache_key)
        if cached_entry:
            age = (time.time() - cached_entry["timestamp"]) * 1000  # in ms
            if age < server_config.get("cacheTTL", 300000):
                duration = int((time.time() - start_time) * 1000)
                
                # Increment usage
                key_obj["usage"] += 1
                write_json(KEYS_PATH, keys)
                
                # Log hit
                log_request(
                    key_obj["name"],
                    request.provider,
                    request.model,
                    request.prompt,
                    cached_entry["answer"],
                    "success",
                    duration,
                    True
                )
                
                return {"text": cached_entry["answer"], "cached": True}
                
    # Route request with retry & fallback
    try:
        result = await execute_llm_with_retry_and_fallback(
            request.provider,
            request.model,
            request.prompt,
            request.temperature,
            request.maxTokens,
            request.systemInstruction,
            server_config
        )
        
        duration = int((time.time() - start_time) * 1000)
        text = result["text"]
        final_model = result["finalModel"]
        final_provider = result.get("finalProvider", request.provider)
        
        # Cache result
        if server_config.get("cacheEnabled"):
            query_cache[cache_key] = {
                "answer": text,
                "timestamp": time.time()
            }
            
        # Increment usage
        key_obj["usage"] += 1
        write_json(KEYS_PATH, keys)
        
        # Save logs (uses the final provider/model used after any failovers!)
        log_request(key_obj["name"], final_provider, final_model, request.prompt, text, "success", duration, False)
        
        return {"text": text, "cached": False, "provider": final_provider, "model": final_model}
        
    except Exception as err:
        duration = int((time.time() - start_time) * 1000)
        
        # Graceful user-facing error notice, hiding raw tracebacks
        friendly_error = "The server is currently experiencing high demand. Please try again in a few moments."
        
        # Still log the raw error on the server for debugging
        log_request(key_obj["name"], request.provider, request.model, request.prompt, f"Error: {err}", "failed", duration, False)
        print("Gateway Forward Error:", err)
        
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=friendly_error
        )

# -------------------------------------------------------------------------
# ADMIN ROUTES: Key Management
# -------------------------------------------------------------------------
class CreateKeyRequest(BaseModel):
    name: str

class UpdateKeyRequest(BaseModel):
    status: str

@app.get("/api/admin/keys")
def get_keys():
    return read_json(KEYS_PATH, [])

@app.post("/api/admin/keys")
def create_key(req_body: CreateKeyRequest):
    name = req_body.name
    if not name or not name.strip():
        raise HTTPException(status_code=400, detail="Key name/description is required.")
        
    random_hex = secrets.token_hex(8)
    new_key = f"star_key_{random_hex}"
    
    keys = read_json(KEYS_PATH, [])
    new_key_obj = {
        "key": new_key,
        "name": name.strip(),
        "status": "active",
        "createdAt": get_utc_iso(),
        "usage": 0
    }
    
    keys.append(new_key_obj)
    write_json(KEYS_PATH, keys)
    return new_key_obj

@app.delete("/api/admin/keys/{key_to_revoke}")
def revoke_key(key_to_revoke: str):
    keys = read_json(KEYS_PATH, [])
    exists = any(k["key"] == key_to_revoke for k in keys)
    
    if not exists:
        raise HTTPException(status_code=404, detail="API Key not found.")
        
    keys = [k for k in keys if k["key"] != key_to_revoke]
    write_json(KEYS_PATH, keys)
    return {"success": True, "message": "API key revoked successfully."}

@app.put("/api/admin/keys/{key_to_update}")
def update_key(key_to_update: str, req_body: UpdateKeyRequest):
    status_val = req_body.status
    keys = read_json(KEYS_PATH, [])
    key_obj = next((k for k in keys if k["key"] == key_to_update), None)
    
    if not key_obj:
        raise HTTPException(status_code=404, detail="API Key not found.")
        
    if status_val:
        key_obj["status"] = status_val
        
    write_json(KEYS_PATH, keys)
    return key_obj

# -------------------------------------------------------------------------
# ADMIN ROUTES: Configuration Management
# -------------------------------------------------------------------------
class ConfigUpdateRequest(BaseModel):
    geminiKey: Optional[str] = None
    openaiKey: Optional[str] = None
    groqKey: Optional[str] = None
    globalSystemInstruction: Optional[str] = None
    cacheEnabled: Optional[bool] = None
    cacheTTL: Optional[int] = None

@app.get("/api/admin/config")
def get_config():
    config = read_json(CONFIG_PATH, initial_config)
    return {
        "geminiConfigured": bool(config.get("geminiKey")),
        "openaiConfigured": bool(config.get("openaiKey")),
        "groqConfigured": bool(config.get("groqKey")),
        "globalSystemInstruction": config.get("globalSystemInstruction", ""),
        "cacheEnabled": config.get("cacheEnabled") is not False,
        "cacheTTL": config.get("cacheTTL", 300000)
    }

@app.post("/api/admin/config")
def update_config(req_body: ConfigUpdateRequest):
    config = read_json(CONFIG_PATH, initial_config)
    
    # Only update keys if sent, not empty, and not masked
    if req_body.geminiKey is not None and req_body.geminiKey.strip() != "" and "••••" not in req_body.geminiKey:
        config["geminiKey"] = req_body.geminiKey.strip()
    if req_body.openaiKey is not None and req_body.openaiKey.strip() != "" and "••••" not in req_body.openaiKey:
        config["openaiKey"] = req_body.openaiKey.strip()
    if req_body.groqKey is not None and req_body.groqKey.strip() != "" and "••••" not in req_body.groqKey:
        config["groqKey"] = req_body.groqKey.strip()
        
    if req_body.globalSystemInstruction is not None:
        config["globalSystemInstruction"] = req_body.globalSystemInstruction.strip()
    if req_body.cacheEnabled is not None:
        config["cacheEnabled"] = bool(req_body.cacheEnabled)
    if req_body.cacheTTL is not None:
        config["cacheTTL"] = int(req_body.cacheTTL) or 300000
        
    write_json(CONFIG_PATH, config)
    
    return {
        "success": True,
        "message": "Configuration saved successfully.",
        "config": {
            "geminiConfigured": bool(config.get("geminiKey")),
            "openaiConfigured": bool(config.get("openaiKey")),
            "groqConfigured": bool(config.get("groqKey")),
            "globalSystemInstruction": config.get("globalSystemInstruction"),
            "cacheEnabled": config.get("cacheEnabled"),
            "cacheTTL": config.get("cacheTTL")
        }
    }

# -------------------------------------------------------------------------
# ADMIN ROUTES: Logs & Stats
# -------------------------------------------------------------------------
@app.get("/api/admin/logs")
def get_logs():
    return read_json(LOGS_JSON_PATH, [])

@app.get("/api/admin/logs/download")
def download_logs():
    if not os.path.exists(LOGS_CSV_PATH):
        raise HTTPException(status_code=404, detail="Logs file is empty or not initialized.")
    return FileResponse(
        LOGS_CSV_PATH,
        media_type="text/csv",
        filename="star_ai_api_logs.csv"
    )

@app.get("/api/admin/logs/archives")
def list_log_archives():
    archives = []
    for filename in sorted(os.listdir(LOG_ARCHIVE_DIR), reverse=True):
        if filename.endswith(".json"):
            file_path = os.path.join(LOG_ARCHIVE_DIR, filename)
            archives.append({
                "filename": filename,
                "size": os.path.getsize(file_path),
                "updatedAt": datetime.fromtimestamp(os.path.getmtime(file_path), timezone.utc).isoformat().replace("+00:00", "Z")
            })
    return archives

@app.get("/api/admin/logs/archives/{filename}")
def download_log_archive(filename: str):
    safe_filename = os.path.basename(filename)
    if safe_filename != filename or not safe_filename.endswith(".json"):
        raise HTTPException(status_code=400, detail="Invalid archive filename.")

    archive_path = os.path.join(LOG_ARCHIVE_DIR, safe_filename)
    if not os.path.exists(archive_path):
        raise HTTPException(status_code=404, detail="Log archive not found.")
    return FileResponse(archive_path, media_type="application/json", filename=safe_filename)

@app.get("/api/admin/stats")
def get_stats():
    logs = read_json(LOGS_JSON_PATH, [])
    keys = read_json(KEYS_PATH, [])
    
    total = len(logs)
    success = sum(1 for l in logs if l.get("status") == "success")
    cached = sum(1 for l in logs if l.get("cached"))
    failed = total - success
    
    cache_hit_rate = f"{(cached / total * 100):.1f}%" if total > 0 else "0.0%"
    success_rate = f"{(success / total * 100):.1f}%" if total > 0 else "100.0%"
    
    # Calculate average duration of non-cached successful requests
    non_cached_success = [l for l in logs if l.get("status") == "success" and not l.get("cached")]
    if non_cached_success:
        avg_duration = f"{sum(l.get('duration', 0) for l in non_cached_success) // len(non_cached_success)}"
    else:
        avg_duration = "0"
        
    # Requests by provider
    provider_stats = {}
    for l in logs:
        provider = l.get("provider", "unknown")
        provider_stats[provider] = provider_stats.get(provider, 0) + 1
        
    return {
        "totalQueries": total,
        "successRate": success_rate,
        "cacheHitRate": cache_hit_rate,
        "avgResponseTime": f"{avg_duration} ms",
        "failedQueries": failed,
        "activeKeys": sum(1 for k in keys if k.get("status") == "active"),
        "providerStats": provider_stats
    }

# -------------------------------------------------------------------------
# AGENT ROUTES
# -------------------------------------------------------------------------
class AgentChatRequest(BaseModel):
    message: str

@app.post("/api/agent/chat")
def agent_chat(req_body: AgentChatRequest):
    # Retrieve the configured Gemini key from config
    config = read_json(CONFIG_PATH, initial_config)
    gemini_key = config.get("geminiKey")
    
    if not gemini_key:
        raise HTTPException(status_code=400, detail="Gemini API Key is not configured.")
        
    response_text = chat_with_agent(req_body.message, gemini_key)
    return {"response": response_text}

# -------------------------------------------------------------------------
# SERVE STATIC CLIENT FILES
# -------------------------------------------------------------------------
# Serve only approved frontend static assets (from 'dist/' if built, otherwise root)
ALLOWED_STATIC_FILES = {"index.html", "style.css", "app.js"}

def get_static_path(file_name: str) -> str:
    return os.path.join(BASE_DIR, "frontend", file_name)

@app.get("/")
def serve_index():
    return FileResponse(get_static_path("index.html"))

@app.get("/{file_name}")
def serve_static(file_name: str):
    if file_name in ALLOWED_STATIC_FILES:
        return FileResponse(get_static_path(file_name))
    raise HTTPException(status_code=404, detail="File Not Found")

if __name__ == "__main__":
    import uvicorn
    port = int(os.getenv("PORT", 3000))
    print(f"====================================================")
    print(f"STAR AI GATEWAY SERVER (FASTAPI) RUNNING ON PORT {port}")
    print(f"Access local dashboard: http://localhost:{port}")
    print(f"====================================================")
    rotate_logs_if_due()  # Run the log rotation check at startup
    sync_pending_drive_archives()
    uvicorn.run("server:app", host="0.0.0.0", port=port, reload=True)

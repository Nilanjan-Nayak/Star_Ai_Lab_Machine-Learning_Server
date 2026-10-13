# Star AI Lab | Machine Learning Server

> A lightweight FastAPI gateway for multi-provider AI requests, local response caching, request analytics, and scheduled Google Drive log archiving.

## What It Does

- Serves the Star AI dashboard and API from one application.
- Routes requests to Gemini, OpenAI, or Groq providers.
- Supports local answers, request caching, API-key management, and usage statistics.
- Stores routed query logs as editable JSON and Excel-compatible CSV files.
- Creates a new JSON log archive every 20 days.
- Uploads completed archives to a configured Google Drive folder when credentials are available.
- Produces an upload-ready deployment ZIP with one command.

## Architecture

```text
Browser dashboard
	|
	v
FastAPI gateway (backend/server.py)
	|
	+-- AI providers: Gemini | OpenAI | Groq
	+-- Local data: database/ and config/
	+-- 20-day JSON archives
		    |
		    +-- Google Drive folder (optional)
```

## Quick Start

### Windows

```powershell
python -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install -r backend\requirements.txt
npm install
npm start
```

Open `http://localhost:3000` after the server starts.

### Development

```powershell
npm run dev
```

## Build An Upload Package

The build creates a deployment archive instead of only compiling source files:

```powershell
npm run build
```

Output:

```text
dist/star-ai-server.zip
```

The package includes the backend, frontend, requirements, database seed data, and deployment instructions. Secrets, `.env`, `.venv`, API keys, and runtime logs are excluded.

## Google Drive Log Archives

The active logs are stored locally in:

```text
database/api_logs.json
database/api_logs.csv
```

Every 20 days, the server creates an editable archive in:

```text
database/log_archives/routed_query_logs_YYYYMMDD_YYYYMMDD.json
```

To upload archives to Google Drive:

1. Create a Google service account and download its JSON key.
2. Share the target Drive folder with the service account email as **Editor**.
3. Copy `.env.example` to `.env`.
4. Set the credential path:

```env
GOOGLE_APPLICATION_CREDENTIALS=C:\path\to\google-service-account.json
```

The folder ID is already configured for the project. Never commit a real credential file or secret value.

## Useful Endpoints

| Endpoint | Method | Purpose |
| --- | --- | --- |
| `/` | `GET` | Dashboard |
| `/api/generate` | `POST` | Generate an AI response |
| `/api/admin/config` | `GET` | Read provider configuration status |
| `/api/admin/logs` | `GET` | Read active routed query logs |
| `/api/admin/logs/download` | `GET` | Download active CSV logs |
| `/api/admin/logs/archives` | `GET` | List JSON log archives |
| `/api/admin/stats` | `GET` | Read usage statistics |

## Production Deployment

Install the dependencies on a Python-capable host and run:

```bash
python -m pip install -r backend/requirements.txt
uvicorn backend.server:app --host 0.0.0.0 --port 3000
```

Set the hosting platform's `PORT` variable when the platform assigns a dynamic port.

### InfinityFree Note

InfinityFree can host the static dashboard files, but it cannot run this FastAPI/Python backend as a shared PHP host. For a working AI application, host the frontend on InfinityFree and run the backend on a Python-capable service such as Render, Railway, or a VPS. Then configure the frontend API base URL to point to that backend.

## Project Layout

```text
backend/       FastAPI server, agents, prompts, and tools
frontend/      Dashboard HTML, CSS, and JavaScript
database/      Local data, active logs, and JSON archives
config/        Runtime configuration generated on first start
build.py       Deployment ZIP builder
```

## Security Notes

- Keep `.env` and Google service-account JSON files private.
- Do not commit provider API keys or generated runtime logs.
- Use HTTPS and restrict administrative endpoints before public production use.

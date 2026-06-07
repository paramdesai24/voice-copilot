# AI Voice Ordering Copilot

A full-stack AI restaurant ordering system that combines a Fastify backend, a real-time Twilio voice agent, and an optional offline speech demo engine. The project is designed to handle natural-language ordering, menu understanding, and restaurant workflow support in a way that is suitable for a hackathon or internship demonstration.

## Overview

The repository is organized around three main parts:

- `petpooja/` — the main TypeScript backend and restaurant orchestration service
- `voice_agent/` — the real-time Twilio voice agent that answers calls and streams audio
- `voice_engine/` — a standalone offline STT/TTS demo engine for speech experimentation

The recommended way to launch the integrated demo is through `run_all.py`, which starts the backend, starts the voice agent, waits for the public tunnel, and then triggers the outbound test call.

## What It Does

- Accepts restaurant orders through a voice call
- Converts speech to text and generates responses in real time
- Routes calls through Twilio Media Streams
- Uses a PostgreSQL-backed backend for restaurant and session data
- Preloads menu and RAG context so the first interaction is fast
- Includes an offline speech engine for local experimentation and testing

## Architecture

```text
Caller
  -> Twilio phone number
  -> voice_agent Flask server
  -> WebSocket media stream
  -> STT / response / TTS pipeline
  -> Twilio plays the response back to the caller
  -> petpooja backend handles menu, chat, and restaurant logic
```

The main runtime flow is:

1. `run_all.py` cleans up old processes.
2. It starts the `petpooja` backend on port `3000`.
3. It starts the voice agent on port `5050`.
4. The agent opens a public tunnel using SSH to `localhost.run`.
5. The Twilio webhook is updated to point to `/incoming-call`.
6. The outbound call is triggered automatically unless `--no-call` is used.

## Repository Structure

```text
.
├── run_all.py
├── run_all.sh
├── run_all.ps1
├── petpooja/
├── voice_agent/
├── voice_engine/
└── logs/
```

## Prerequisites

Before running the project, install:

- Node.js 20 or newer
- Python 3.10 or newer
- npm
- PostgreSQL
- OpenSSH client for the public tunnel used by the voice agent
- A Twilio account and a Twilio phone number
- Internet access for model and API calls

## Setup

### 1. Backend: `petpooja`

Create a `.env` file inside `petpooja/` using `petpooja/.env.example` as the base.

Minimum values you must provide:

- `API_BASE_URL`
- `DB_PASSWORD`
- `GEMINI_API_KEY`
- `POS_API_KEY`
- `POS_RESTAURANT_ID`
- `API_SECRET_KEY`

Typical setup:

```bash
cd petpooja
cp .env.example .env
npm install
```

If you want to verify the backend separately:

```bash
npm run dev
```

The backend listens on port `3000` by default and exposes a health endpoint at `/health`.

### 2. Voice Agent: `voice_agent`

Create `voice_agent/.env` and provide:

- `TWILIO_ACCOUNT_SID`
- `TWILIO_AUTH_TOKEN`
- `TWILIO_PHONE_NUMBER`
- `PORT` if you want to override the default `5000`

Install Python dependencies:

```bash
python -m pip install -r voice_agent/requirements.txt
```

Run the agent directly if needed:

```bash
python voice_agent/start_agent.py
```

The agent starts a Flask app, creates a public tunnel, and updates the Twilio webhook to `/incoming-call`.

### 3. Offline Speech Demo: `voice_engine`

This folder is optional if you only want the full call demo, but it is useful for local speech experiments.

```bash
cd voice_engine
python -m pip install -r requirements.txt
python demo_pipeline.py
```

## Recommended Run Flow

From the repository root:

```bash
python run_all.py
```

To start everything but skip the outbound call trigger:

```bash
python run_all.py --no-call
```

The script will:

- stop old processes on ports `3000` and `5050`
- start the backend
- start the voice agent
- wait for the public tunnel URL
- configure the Twilio webhook
- trigger the call

Logs are written to:

- `logs/petpooja.log`
- `logs/agent.log`

## Manual Run Mode

If you want to start each service yourself:

### Backend

```bash
cd petpooja
npm run dev
```

### Voice Agent

```bash
python voice_agent/start_agent.py
```

### Trigger the Call Manually

```bash
python voice_agent/trigger_call.py
```

## Important Endpoints

### Backend

- `GET /health` — readiness check
- `GET /demo` — demo UI
- `GET /kot` — kitchen order ticket view
- API routes are registered through `petpooja/src/api/routes`

### Voice Agent

- `POST /incoming-call` — Twilio webhook entrypoint
- `GET /health` — voice agent health check
- `WebSocket /media-stream` — live Twilio Media Streams connection

## Environment Notes

### `petpooja`

The backend validates environment variables through `petpooja/src/config/env.ts`. If startup fails, check your `.env` file first.

Important required settings include:

- `API_BASE_URL`
- `DB_PASSWORD`
- `GEMINI_API_KEY`
- `POS_API_KEY`
- `POS_RESTAURANT_ID`
- `API_SECRET_KEY`

Optional integrations include:

- `DEEPGRAM_API_KEY`
- `TWILIO_ACCOUNT_SID`
- `TWILIO_AUTH_TOKEN`
- `TWILIO_PHONE_NUMBER`
- `CLOUDFLARE_ACCOUNT_ID`
- `CLOUDFLARE_API_TOKEN`
- `GROQ_API_KEY`

### `voice_agent`

The agent currently uses an SSH tunnel to `localhost.run` for public access. Make sure `ssh` is available on your system.

## Troubleshooting

- If the backend fails to start, confirm the PostgreSQL connection details and required `.env` values.
- If the voice agent logs a tunnel error, verify that `ssh` is installed and outbound network access is available.
- If Twilio webhook updates fail, re-check the account SID, auth token, and Twilio phone number.
- If the call connects but no audio is heard, confirm that the voice agent is running and that the `/incoming-call` route is reachable through the public tunnel.
- If `run_all.py` cannot find the local Python environment, it falls back to the current interpreter. Installing a `.venv` in the repository root is recommended.

## Validation and Testing

Useful commands:

```bash
cd petpooja
npm test
```

```bash
cd voice_engine
python -m pytest tests -v
```

For a quick voice-agent import check:

```bash
python voice_agent/start_agent.py --dry-run
```

## Submission Summary

This project demonstrates an end-to-end AI restaurant ordering experience that combines backend orchestration, real-time telephony, speech processing, and restaurant-focused workflow support. It is suitable for an internship or hackathon submission because it shows both product thinking and systems integration.

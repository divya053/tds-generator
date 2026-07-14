# Flask Backend - Lighting Spec Extractor

This is the Python/Flask backend that extracts lighting specs from vendor PDFs.
It supports two LLM providers, selected with `LLM_PROVIDER`:

- `ollama` (default) - a local model via [Ollama](https://ollama.com). Fully offline, but slow on CPU (~6 min per PDF for a 7B model).
- `groq` - the hosted [Groq API](https://console.groq.com). Needs a free API key, but returns results in seconds.

## Prerequisites

1. **Python 3.9+** installed
2. For local mode: **Ollama** installed and running (https://ollama.com/download) with a model pulled, e.g. `qwen2.5:7b`
3. For Groq mode: a free API key from https://console.groq.com/keys

## Setup (Windows)

```batch
cd flask-backend

python -m venv venv
venv\Scripts\activate

pip install -r requirements.txt
```

## Pull the Ollama model

```batch
ollama pull qwen2.5:7b
```

## Run the Flask backend

```batch
python app.py
```

The Flask server will start on port 5005 by default.

## Using Groq instead of a local model

Groq is much faster than a local CPU model. Get a free key at https://console.groq.com/keys, then:

```batch
set "LLM_PROVIDER=groq"
set "GROQ_API_KEY=your_key_here"
python app.py
```

## Environment Variables (optional)

- `LLM_PROVIDER` - `ollama` (default) or `groq`
- `FLASK_PORT` - Port to run on (default: 5005)
- `OLLAMA_URL` - Ollama server URL (default: http://localhost:11434)
- `OLLAMA_MODEL` - Model to use (default: qwen2.5:7b)
- `OLLAMA_TIMEOUT_SECONDS` - Ollama request timeout in seconds (default: 300)
- `GROQ_API_KEY` - Groq API key (required when `LLM_PROVIDER=groq`)
- `GROQ_MODEL` - Groq model (default: llama-3.3-70b-versatile)
- `GROQ_URL` - Groq OpenAI-compatible base URL (default: https://api.groq.com/openai/v1)
- `GROQ_TIMEOUT_SECONDS` - Groq request timeout in seconds (default: 120)

## API

- `GET /health` - Health check
- `POST /process-pdf` - Upload a PDF file, get structured JSON back
  - Form field: `file` (PDF)

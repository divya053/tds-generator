# Flask Backend - Lighting Spec Extractor

This is the Python/Flask backend that uses Ollama to extract lighting specs from vendor PDFs.

## Prerequisites

1. **Python 3.9+** installed
2. **Ollama** installed and running: https://ollama.com/download
3. **glm4.6:cloud model** pulled in Ollama

## Setup (Windows)

```batch
cd flask-backend

python -m venv venv
venv\Scripts\activate

pip install -r requirements.txt
```

## Pull the Ollama model

```batch
ollama pull glm4.6:cloud
```

## Run the Flask backend

```batch
python app.py
```

The Flask server will start on port 5001.

## Environment Variables (optional)

- `FLASK_PORT` - Port to run on (default: 5001)
- `OLLAMA_URL` - Ollama server URL (default: http://localhost:11434)
- `OLLAMA_MODEL` - Model to use (default: glm4.6:cloud)

## API

- `GET /health` - Health check
- `POST /process-pdf` - Upload a PDF file, get structured JSON back
  - Form field: `file` (PDF)

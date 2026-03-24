# Workspace

## Overview

Lighting vendor spec sheet extraction system. Upload vendor PDF spec sheets and automatically extract structured product data using the GLM-4.6 AI model via Ollama.

## Stack

- **Monorepo tool**: pnpm workspaces
- **Node.js version**: 24
- **Package manager**: pnpm
- **TypeScript version**: 5.9
- **API framework**: Express 5
- **Database**: PostgreSQL + Drizzle ORM
- **Validation**: Zod (`zod/v4`), `drizzle-zod`
- **API codegen**: Orval (from OpenAPI spec)
- **Build**: esbuild
- **Frontend**: React + Vite (Tailwind, Framer Motion, react-dropzone)
- **Python backend**: Flask + pdfplumber (calls Ollama)
- **AI Model**: glm4.6:cloud via Ollama

## Architecture

```
Browser → React Frontend (spec-extractor artifact, port 21774)
        → Express API Server (/api, port 8080)
        → Flask Backend (port 5001)
        → Ollama (localhost:11434, model: glm4.6:cloud)
```

## Structure

```text
artifacts-monorepo/
├── artifacts/
│   ├── api-server/         # Express API server (routes: health, extract)
│   └── spec-extractor/     # React + Vite frontend
├── flask-backend/
│   ├── app.py              # Flask server - PDF extraction via Ollama
│   ├── requirements.txt    # Python dependencies
│   └── README.md           # Local setup guide
├── lib/
│   ├── api-spec/           # OpenAPI spec + Orval codegen config
│   ├── api-client-react/   # Generated React Query hooks
│   ├── api-zod/            # Generated Zod schemas from OpenAPI
│   └── db/                 # Drizzle ORM schema + DB connection
│       └── src/schema/
│           └── extractions.ts  # Extractions table schema
└── scripts/
```

## Key Features

- Drag-and-drop PDF upload
- AI extraction of: Product Name, Description, Features, Application Areas, Technical Specs Table, Vendor Info
- Extraction history with full detail view
- Download extracted data as JSON
- Delete extractions

## Running Locally (Windows)

### Prerequisites
1. Node.js 18+, pnpm
2. Python 3.9+
3. Ollama installed: https://ollama.com/download
4. PostgreSQL database (or use Replit's)

### Setup
```bash
# Pull the AI model
ollama pull glm4.6:cloud

# Install Node dependencies
pnpm install

# Install Python dependencies (in flask-backend/)
cd flask-backend
pip install -r requirements.txt

# Run all services:
# Terminal 1: Flask backend
python flask-backend/app.py

# Terminal 2: Express API
pnpm --filter @workspace/api-server run dev

# Terminal 3: React frontend
pnpm --filter @workspace/spec-extractor run dev
```

## Environment Variables

- `DATABASE_URL` - PostgreSQL connection string (auto-set by Replit)
- `FLASK_URL` - Flask backend URL (default: http://localhost:5001)
- `OLLAMA_URL` - Ollama URL (default: http://localhost:11434)
- `OLLAMA_MODEL` - Model to use (default: glm4.6:cloud)
- `FLASK_PORT` - Flask port (default: 5001)

## API Endpoints

- `GET /api/healthz` - Health check
- `POST /api/extract` - Upload PDF, extract specs
- `GET /api/extract/history` - List all extractions
- `GET /api/extract/:id` - Get extraction by ID
- `DELETE /api/extract/:id` - Delete extraction
- `GET /health` (Flask) - Flask health check
- `POST /process-pdf` (Flask) - Process PDF with Ollama

## Database Schema

- `extractions` table: id, filename, productName, alternateName, productDescription, productFeatures (jsonb), applicationAreas (jsonb), technicalSpecs (jsonb), notes (jsonb), vendorInfo (jsonb), rawJson, createdAt

## Workflows (Replit)

- `Flask Backend` - Python Flask server on port 5001
- `artifacts/api-server: API Server` - Express API on port 8080
- `artifacts/spec-extractor: web` - React frontend on port 21774

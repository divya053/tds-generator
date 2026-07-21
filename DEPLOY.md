# Deploying IKIO TDS Generator to a CloudPanel VPS

The app has three parts:

| Part | Port | What it is |
|------|------|-----------|
| **Flask backend** | 5005 (localhost) | PDF extraction + Gemini AI |
| **Node API** | 8787 (localhost) | Auth, extraction store, drafts, proxies to Flask |
| **Frontend** | served by nginx | React static build (`artifacts/spec-extractor/dist/public`) |

nginx serves the static frontend and reverse-proxies `/api` → Node (8787); Node talks to Flask (5005). Both backends store data as JSON files under `data/` (no MySQL required).

---

## 1. SSH in and install prerequisites

```bash
ssh root@72.61.243.59            # or your CloudPanel SSH user

# Node 20 + pnpm
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt-get install -y nodejs
npm install -g pnpm pm2

# Python 3.11 + venv
apt-get install -y python3 python3-venv python3-pip
```

## 2. Get the code (as the site user)

CloudPanel created the site `ikiousa.tech` with user `ikiousa` (home: `/home/ikiousa`).

```bash
su - ikiousa
cd /home/ikiousa
git clone https://github.com/divya053/tds-generator.git app
cd app
```

## 3. Install & build

```bash
# Node workspaces (frontend + api-server)
pnpm install
pnpm --filter @workspace/api-server run build

# Frontend production build (served by nginx)
pnpm --filter @workspace/spec-extractor run build
# -> output: artifacts/spec-extractor/dist/public

# Python backend
cd flask-backend
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
cd ..
```

## 4. Configure the Gemini key

```bash
cat > flask-backend/.env <<'EOF'
LLM_PROVIDER=gemini
GEMINI_API_KEY=AIza-or-AQ.-your-key-here
GEMINI_MODEL=gemini-3-flash-preview
ENABLE_REVIEW=1
PDF_RENDER_SCALE=3.0
EOF
```

> On a VPS there's no Ollama fallback (no local model), so a **valid Gemini key is required**.
> Paddle OCR is heavy — set `ENABLE_PADDLE_OCR=0` in `.env` if your PDFs already have a text layer.

## 5. Run both backends with pm2 (auto-restart + boot startup)

```bash
cd /home/ikiousa/app

# Flask (uses the venv python)
pm2 start flask-backend/.venv/bin/python \
  --name tds-flask --cwd /home/ikiousa/app -- flask-backend/app.py

pm2 set tds-flask:FLASK_PORT 5005     # or export before start

# Node API
FLASK_URL=http://localhost:5005 PORT=8787 \
  pm2 start artifacts/api-server/dist/index.mjs --name tds-api --node-args="--enable-source-maps"

pm2 save
pm2 startup systemd    # run the command it prints (as root) to start on boot
```

Verify:
```bash
curl -s http://localhost:5005/health          # {"status":"ok"}
curl -s http://localhost:8787/api/healthz      # {"status":"ok"}
```

## 6. Point CloudPanel's nginx at the app

In CloudPanel → Site `ikiousa.tech` → **Vhost**, set the site root and add the `/api` proxy. Replace the `location /` block with:

```nginx
root /home/ikiousa/app/artifacts/spec-extractor/dist/public;
index index.html;

# SPA: serve index.html for client-side routes (/spec/NN etc.)
location / {
    try_files $uri $uri/ /index.html;
}

# Reverse-proxy the API + AI + name registry to the Node server
location /api/ {
    proxy_pass http://127.0.0.1:8787;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    client_max_body_size 64m;      # large PDF uploads + image drafts
    proxy_read_timeout 900s;       # Gemini extraction can take a while
}
```

Save (CloudPanel reloads nginx). Then add **SSL/TLS → Let's Encrypt** for `ikiousa.tech`.

## 7. Done

Open `https://ikiousa.tech`. Uploads hit `/api/extract` → Node → Flask → Gemini.

---

## Updating later

```bash
su - ikiousa && cd /home/ikiousa/app
git pull
pnpm install
pnpm --filter @workspace/api-server run build
pnpm --filter @workspace/spec-extractor run build
pm2 restart tds-flask tds-api
```

## Data & backups

Runtime data (git-ignored) lives in:
- `artifacts/api-server/data/` — extractions + editor drafts
- `flask-backend/data/` — extraction cache + product-name registry

Back these folders up to keep extractions, edits, and reserved names.

## Notes
- The app's login is cookie-based; keep it behind HTTPS (step 6 SSL).
- The MySQL `esco` DB isn't used by the app (it stores JSON files). Ignore it unless you later migrate storage to MySQL.
- Firewall: only 80/443 need to be public; 5005 and 8787 stay on localhost.

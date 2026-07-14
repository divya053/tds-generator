const express = require("express");
const multer = require("multer");
const FormData = require("form-data");
const fetch = require("node-fetch");
const cors = require("cors");
const fs = require("fs");
const path = require("path");

const app = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });

const FLASK_URL = process.env.FLASK_URL || "http://localhost:5001";
const PORT = process.env.PORT || 3000;
const DATA_FILE = path.join(__dirname, "extractions.json");
const SAVE_EXTRACTION_HISTORY = String(process.env.SAVE_EXTRACTION_HISTORY || "false").toLowerCase() === "true";

// Serve the built React frontend if it exists
const FRONTEND_DIST = path.join(__dirname, "..", "artifacts", "spec-extractor", "dist", "public");
if (fs.existsSync(FRONTEND_DIST)) {
  app.use(express.static(FRONTEND_DIST));
} else {
  console.warn("[WARNING] Frontend not built yet. Run: npm run build:frontend");
}

app.use(cors());
app.use(express.json());

function loadData() {
  if (!fs.existsSync(DATA_FILE)) return [];
  try { return JSON.parse(fs.readFileSync(DATA_FILE, "utf-8")); } catch { return []; }
}

function saveData(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

app.get("/api/healthz", (_req, res) => {
  res.json({ status: "ok" });
});

app.post("/api/extract", upload.single("file"), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: "No file uploaded", detail: "Please upload a PDF file" });
  }

  const filename = req.file.originalname;

  try {
    const form = new FormData();
    form.append("file", req.file.buffer, { filename, contentType: req.file.mimetype });

    console.log(`[INFO] Sending ${filename} to Flask at ${FLASK_URL}/process-pdf ...`);
    const flaskRes = await fetch(`${FLASK_URL}/process-pdf`, {
      method: "POST",
      body: form,
      headers: form.getHeaders(),
    });

    if (!flaskRes.ok) {
      const errBody = await flaskRes.text();
      console.error("[ERROR] Flask returned:", flaskRes.status, errBody);
      return res.status(500).json({ error: "Extraction failed", detail: errBody });
    }

    const extracted = await flaskRes.json();
    const data = loadData();
    const nextPersistedId = data.length > 0 ? Math.max(...data.map(d => d.id)) + 1 : 1;
    const id = SAVE_EXTRACTION_HISTORY ? nextPersistedId : Date.now();
    const record = {
      id,
      filename,
      ...extracted,
      productName: extracted.productName || "Unknown Product",
      alternateName: extracted.alternateName || "",
      productDescription: extracted.productDescription || "",
      productFeatures: extracted.productFeatures || [],
      applicationAreas: extracted.applicationAreas || [],
      productCategory: extracted.productCategory || "",
      isProductFamily: typeof extracted.isProductFamily === "boolean" ? extracted.isProductFamily : false,
      variantOverview: extracted.variantOverview || { parameters: ["Wattage", "Lumen Output", "CCT", "Efficacy"], matrix: [] },
      variants: extracted.variants || [],
      technicalSpecs: extracted.technicalSpecs || [],
      categorySpecificSpecs: extracted.categorySpecificSpecs || [],
      notes: extracted.notes || [],
      vendorInfo: extracted.vendorInfo || { vendorName: "", vendorContact: "" },
      createdAt: new Date().toISOString(),
    };

    if (SAVE_EXTRACTION_HISTORY) {
      data.push(record);
      saveData(data);
      console.log(`[INFO] Saved extraction ID ${id}: ${record.productName}`);
    } else {
      console.log(`[INFO] History save disabled; returning unsaved extraction for: ${record.productName}`);
    }
    res.json(record);
  } catch (err) {
    console.error("[ERROR] Processing PDF:", err.message);
    if (err.code === "ECONNREFUSED") {
      return res.status(503).json({
        error: "Cannot connect to Flask backend",
        detail: `Make sure Flask is running at ${FLASK_URL}. Run: python flask-backend/app.py`
      });
    }
    res.status(500).json({ error: "Extraction failed", detail: err.message });
  }
});

app.get("/api/extract/history", (_req, res) => {
  const data = loadData();
  res.json(data.map(({ id, filename, productName, createdAt }) => ({ id, filename, productName, createdAt })).reverse());
});

app.get("/api/extract/:id", (req, res) => {
  const id = Number(req.params.id);
  const data = loadData();
  const record = data.find(d => d.id === id);
  if (!record) return res.status(404).json({ error: "Not found" });
  res.json(record);
});

app.delete("/api/extract/:id", (req, res) => {
  const id = Number(req.params.id);
  const data = loadData();
  const idx = data.findIndex(d => d.id === id);
  if (idx === -1) return res.status(404).json({ error: "Not found" });
  data.splice(idx, 1);
  saveData(data);
  res.json({ message: "Deleted successfully" });
});

// Serve React app for all other routes (SPA fallback)
app.get("*", (req, res) => {
  const indexFile = path.join(FRONTEND_DIST, "index.html");
  if (fs.existsSync(indexFile)) {
    res.sendFile(indexFile);
  } else {
    res.status(200).send(`
      <html><body style="font-family:sans-serif;padding:40px;background:#0f172a;color:#e2e8f0">
        <h2>Frontend not built yet</h2>
        <p>Run this command to build the frontend, then restart this server:</p>
        <pre style="background:#1e293b;padding:16px;border-radius:8px">BUILD-FRONTEND.bat</pre>
        <p>Or build manually from the project root:<br>
        <code>cd artifacts\\spec-extractor && set PORT=3000 && set BASE_PATH=/ && npx vite build</code></p>
      </body></html>
    `);
  }
});

app.listen(PORT, () => {
  console.log(`\n================================`);
  console.log(` Lighting Spec Extractor`);
  console.log(`================================`);
  console.log(` Open: http://localhost:${PORT}`);
  console.log(` API:  http://localhost:${PORT}/api`);
  console.log(` Flask expected at: ${FLASK_URL}`);
  console.log(`================================\n`);
});

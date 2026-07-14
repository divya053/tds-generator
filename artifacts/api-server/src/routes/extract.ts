import { Router, type IRouter } from "express";
import multer from "multer";
import FormData from "form-data";
import fetch from "node-fetch";

const router: IRouter = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });

const FLASK_URL = (process.env.FLASK_URL ?? "http://localhost:5005").trim();

type SourceAsset = {
  id: string;
  page: number;
  width: number;
  height: number;
  dataUrl: string;
};

type TechnicalSpec = {
  parameter: string;
  specification: string;
};

type VariantOverview = {
  parameters: string[];
  matrix: string[][];
};

type ExtractedPayload = {
  productName?: string;
  alternateName?: string;
  productDescription?: string;
  productFeatures?: string[];
  applicationAreas?: string[];
  productCategory?: string;
  isProductFamily?: boolean;
  variantOverview?: VariantOverview;
  variants?: Record<string, unknown>[];
  technicalSpecs?: TechnicalSpec[];
  categorySpecificSpecs?: TechnicalSpec[];
  notes?: string[];
  vendorInfo?: { vendorName: string; vendorContact: string };
  sourceImages?: SourceAsset[];
  sourcePages?: SourceAsset[];
};

type StoredExtraction = {
  id: number;
  filename: string;
  productName: string;
  alternateName: string;
  productDescription: string;
  productFeatures: string[];
  applicationAreas: string[];
  productCategory: string;
  isProductFamily: boolean;
  variantOverview: VariantOverview;
  variants: Record<string, unknown>[];
  technicalSpecs: TechnicalSpec[];
  categorySpecificSpecs: TechnicalSpec[];
  notes: string[];
  vendorInfo: { vendorName: string; vendorContact: string };
  sourceImages: SourceAsset[];
  sourcePages: SourceAsset[];
  createdAt: string;
  pdfBuffer: Buffer;
};

const extractionStore = new Map<number, StoredExtraction>();
let nextExtractionId = 1;

function normalizeStringArray(value: unknown) {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function normalizeTechnicalSpecs(value: unknown) {
  return Array.isArray(value)
    ? value.filter(
        (item): item is TechnicalSpec =>
          typeof item === "object" &&
          item !== null &&
          typeof (item as TechnicalSpec).parameter === "string" &&
          typeof (item as TechnicalSpec).specification === "string",
      )
    : [];
}

function normalizeSourceAssets(value: unknown) {
  return Array.isArray(value)
    ? value.filter(
        (item): item is SourceAsset =>
          typeof item === "object" &&
          item !== null &&
          typeof (item as SourceAsset).id === "string" &&
          typeof (item as SourceAsset).page === "number" &&
          typeof (item as SourceAsset).width === "number" &&
          typeof (item as SourceAsset).height === "number" &&
          typeof (item as SourceAsset).dataUrl === "string",
      )
    : [];
}

function normalizeVariantOverview(value: unknown): VariantOverview {
  if (
    value &&
    typeof value === "object" &&
    Array.isArray((value as VariantOverview).parameters) &&
    (value as VariantOverview).parameters.every((item) => typeof item === "string") &&
    Array.isArray((value as VariantOverview).matrix) &&
    (value as VariantOverview).matrix.every(
      (row) => Array.isArray(row) && row.every((item) => typeof item === "string"),
    )
  ) {
    return value as VariantOverview;
  }

  return { parameters: ["Wattage", "Lumen Output", "CCT", "Efficacy"], matrix: [] };
}

function normalizeVariants(value: unknown) {
  return Array.isArray(value)
    ? value.filter((item): item is Record<string, unknown> => typeof item === "object" && item !== null)
    : [];
}

function serializeExtraction(record: StoredExtraction) {
  const { pdfBuffer: _pdfBuffer, ...payload } = record;
  return payload;
}

router.post("/extract", upload.single("file"), async (req, res) => {
  if (!req.file) {
    res.status(400).json({ error: "No file uploaded", detail: "Please upload a PDF file" });
    return;
  }

  try {
    const form = new FormData();
    form.append("file", req.file.buffer, { filename: req.file.originalname, contentType: req.file.mimetype });

    const flaskRes = await fetch(`${FLASK_URL}/process-pdf`, {
      method: "POST",
      body: form,
      headers: form.getHeaders(),
    });

    if (!flaskRes.ok) {
      const errBody = await flaskRes.text();
      req.log.error({ status: flaskRes.status, body: errBody }, "Flask error");

      const contentType = flaskRes.headers.get("content-type") ?? "";
      if (contentType.includes("application/json")) {
        try {
          res.status(flaskRes.status).json(JSON.parse(errBody) as Record<string, unknown>);
          return;
        } catch {
          // Fall through to the generic wrapper below.
        }
      }

      res.status(flaskRes.status).json({ error: "Extraction failed", detail: errBody || flaskRes.statusText });
      return;
    }

    const extracted = (await flaskRes.json()) as ExtractedPayload;
    const id = nextExtractionId++;
    const createdAt = new Date().toISOString();

    const stored: StoredExtraction = {
      id,
      filename: req.file.originalname,
      productName: extracted.productName ?? "Unknown Product",
      alternateName: extracted.alternateName ?? "",
      productDescription: extracted.productDescription ?? "",
      productFeatures: normalizeStringArray(extracted.productFeatures),
      applicationAreas: normalizeStringArray(extracted.applicationAreas),
      productCategory: extracted.productCategory ?? "",
      isProductFamily: typeof extracted.isProductFamily === "boolean" ? extracted.isProductFamily : false,
      variantOverview: normalizeVariantOverview(extracted.variantOverview),
      variants: normalizeVariants(extracted.variants),
      technicalSpecs: normalizeTechnicalSpecs(extracted.technicalSpecs),
      categorySpecificSpecs: normalizeTechnicalSpecs(extracted.categorySpecificSpecs),
      notes: normalizeStringArray(extracted.notes),
      vendorInfo: extracted.vendorInfo ?? { vendorName: "", vendorContact: "" },
      sourceImages: normalizeSourceAssets(extracted.sourceImages),
      sourcePages: normalizeSourceAssets(extracted.sourcePages),
      createdAt,
      pdfBuffer: req.file.buffer,
    };

    extractionStore.set(id, stored);
    res.json(serializeExtraction(stored));
  } catch (err) {
    req.log.error({ err }, "Error processing PDF");
    res.status(500).json({ error: "Extraction failed", detail: String(err) });
  }
});

router.get("/extract/:id/source-pdf", async (req, res) => {
  const id = Number(req.params.id);
  if (Number.isNaN(id)) {
    res.status(400).json({ error: "Invalid ID" });
    return;
  }

  const record = extractionStore.get(id);
  if (!record) {
    res.status(404).json({ error: "Not found" });
    return;
  }

  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `inline; filename="${record.filename.replace(/"/g, "")}"`);
  res.send(record.pdfBuffer);
});

router.get("/extract/history", async (_req, res) => {
  const history = Array.from(extractionStore.values())
    .sort((left, right) => new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime())
    .map((record) => ({
      id: record.id,
      filename: record.filename,
      productName: record.productName,
      createdAt: record.createdAt,
    }));

  res.json(history);
});

router.get("/extract/:id", async (req, res) => {
  const id = Number(req.params.id);
  if (Number.isNaN(id)) {
    res.status(400).json({ error: "Invalid ID" });
    return;
  }

  const record = extractionStore.get(id);
  if (!record) {
    res.status(404).json({ error: "Not found" });
    return;
  }

  res.json(serializeExtraction(record));
});

router.delete("/extract/:id", async (req, res) => {
  const id = Number(req.params.id);
  if (Number.isNaN(id)) {
    res.status(400).json({ error: "Invalid ID" });
    return;
  }

  if (!extractionStore.delete(id)) {
    res.status(404).json({ error: "Not found" });
    return;
  }

  res.json({ message: "Deleted successfully" });
});

export default router;

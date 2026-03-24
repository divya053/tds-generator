import { Router, type IRouter } from "express";
import multer from "multer";
import FormData from "form-data";
import fetch from "node-fetch";
import { db, extractionsTable } from "@workspace/db";
import { eq, desc } from "drizzle-orm";

const router: IRouter = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });

const FLASK_URL = process.env.FLASK_URL ?? "http://localhost:5001";

router.post("/extract", upload.single("file"), async (req, res) => {
  if (!req.file) {
    res.status(400).json({ error: "No file uploaded", detail: "Please upload a PDF file" });
    return;
  }

  const filename = req.file.originalname;

  try {
    const form = new FormData();
    form.append("file", req.file.buffer, { filename, contentType: req.file.mimetype });

    const flaskRes = await fetch(`${FLASK_URL}/process-pdf`, {
      method: "POST",
      body: form,
      headers: form.getHeaders(),
    });

    if (!flaskRes.ok) {
      const errBody = await flaskRes.text();
      req.log.error({ status: flaskRes.status, body: errBody }, "Flask error");
      res.status(500).json({ error: "Extraction failed", detail: errBody });
      return;
    }

    const extracted = (await flaskRes.json()) as {
      productName?: string;
      alternateName?: string;
      productDescription?: string;
      productFeatures?: string[];
      applicationAreas?: string[];
      technicalSpecs?: { parameter: string; specification: string }[];
      notes?: string[];
      vendorInfo?: { vendorName: string; vendorContact: string };
    };

    const [saved] = await db
      .insert(extractionsTable)
      .values({
        filename,
        productName: extracted.productName ?? "Unknown Product",
        alternateName: extracted.alternateName ?? "",
        productDescription: extracted.productDescription ?? "",
        productFeatures: extracted.productFeatures ?? [],
        applicationAreas: extracted.applicationAreas ?? [],
        technicalSpecs: extracted.technicalSpecs ?? [],
        notes: extracted.notes ?? [],
        vendorInfo: extracted.vendorInfo ?? { vendorName: "", vendorContact: "" },
        rawJson: extracted as object,
      })
      .returning();

    res.json({
      id: saved.id,
      filename: saved.filename,
      productName: saved.productName,
      alternateName: saved.alternateName,
      productDescription: saved.productDescription,
      productFeatures: saved.productFeatures,
      applicationAreas: saved.applicationAreas,
      technicalSpecs: saved.technicalSpecs,
      notes: saved.notes,
      vendorInfo: saved.vendorInfo,
      createdAt: saved.createdAt.toISOString(),
    });
  } catch (err) {
    req.log.error({ err }, "Error processing PDF");
    res.status(500).json({ error: "Extraction failed", detail: String(err) });
  }
});

router.get("/extract/history", async (req, res) => {
  try {
    const rows = await db
      .select({
        id: extractionsTable.id,
        filename: extractionsTable.filename,
        productName: extractionsTable.productName,
        createdAt: extractionsTable.createdAt,
      })
      .from(extractionsTable)
      .orderBy(desc(extractionsTable.createdAt));

    res.json(
      rows.map((r) => ({
        id: r.id,
        filename: r.filename,
        productName: r.productName,
        createdAt: r.createdAt.toISOString(),
      }))
    );
  } catch (err) {
    req.log.error({ err }, "Error fetching history");
    res.status(500).json({ error: "Failed to fetch history", detail: String(err) });
  }
});

router.get("/extract/:id", async (req, res) => {
  const id = Number(req.params.id);
  if (Number.isNaN(id)) {
    res.status(400).json({ error: "Invalid ID" });
    return;
  }

  try {
    const [row] = await db.select().from(extractionsTable).where(eq(extractionsTable.id, id));
    if (!row) {
      res.status(404).json({ error: "Not found" });
      return;
    }

    res.json({
      id: row.id,
      filename: row.filename,
      productName: row.productName,
      alternateName: row.alternateName,
      productDescription: row.productDescription,
      productFeatures: row.productFeatures,
      applicationAreas: row.applicationAreas,
      technicalSpecs: row.technicalSpecs,
      notes: row.notes,
      vendorInfo: row.vendorInfo,
      createdAt: row.createdAt.toISOString(),
    });
  } catch (err) {
    req.log.error({ err }, "Error fetching extraction");
    res.status(500).json({ error: "Failed to fetch extraction", detail: String(err) });
  }
});

router.delete("/extract/:id", async (req, res) => {
  const id = Number(req.params.id);
  if (Number.isNaN(id)) {
    res.status(400).json({ error: "Invalid ID" });
    return;
  }

  try {
    const [deleted] = await db.delete(extractionsTable).where(eq(extractionsTable.id, id)).returning();
    if (!deleted) {
      res.status(404).json({ error: "Not found" });
      return;
    }

    res.json({ message: "Deleted successfully" });
  } catch (err) {
    req.log.error({ err }, "Error deleting extraction");
    res.status(500).json({ error: "Failed to delete extraction", detail: String(err) });
  }
});

export default router;

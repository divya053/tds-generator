import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const extractionsTable = sqliteTable("extractions", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  filename: text("filename").notNull(),
  productName: text("product_name").notNull(),
  alternateName: text("alternate_name").notNull().default(""),
  productDescription: text("product_description").notNull().default(""),
  productFeatures: text("product_features", { mode: "json" }).$type<string[]>().notNull().default([]),
  applicationAreas: text("application_areas", { mode: "json" }).$type<string[]>().notNull().default([]),
  technicalSpecs: text("technical_specs", { mode: "json" }).$type<{ parameter: string; specification: string }[]>().notNull().default([]),
  notes: text("notes", { mode: "json" }).$type<string[]>().notNull().default([]),
  vendorInfo: text("vendor_info", { mode: "json" }).$type<{ vendorName: string; vendorContact: string }>().notNull().default({ vendorName: "", vendorContact: "" }),
  sourceImages: text("source_images", { mode: "json" }).$type<{ id: string; page: number; width: number; height: number; dataUrl: string }[]>().notNull().default([]),
  sourcePages: text("source_pages", { mode: "json" }).$type<{ id: string; page: number; width: number; height: number; dataUrl: string }[]>().notNull().default([]),
  rawJson: text("raw_json", { mode: "json" }).$type<Record<string, unknown> | null>(),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().$defaultFn(() => new Date()),
});

export const insertExtractionSchema = createInsertSchema(extractionsTable).omit({ id: true, createdAt: true });
export type InsertExtraction = z.infer<typeof insertExtractionSchema>;
export type Extraction = typeof extractionsTable.$inferSelect;

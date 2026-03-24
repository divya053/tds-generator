import { pgTable, serial, text, timestamp, jsonb } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const extractionsTable = pgTable("extractions", {
  id: serial("id").primaryKey(),
  filename: text("filename").notNull(),
  productName: text("product_name").notNull(),
  alternateName: text("alternate_name").notNull().default(""),
  productDescription: text("product_description").notNull().default(""),
  productFeatures: jsonb("product_features").$type<string[]>().notNull().default([]),
  applicationAreas: jsonb("application_areas").$type<string[]>().notNull().default([]),
  technicalSpecs: jsonb("technical_specs").$type<{ parameter: string; specification: string }[]>().notNull().default([]),
  notes: jsonb("notes").$type<string[]>().notNull().default([]),
  vendorInfo: jsonb("vendor_info").$type<{ vendorName: string; vendorContact: string }>().notNull().default({ vendorName: "", vendorContact: "" }),
  rawJson: jsonb("raw_json"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const insertExtractionSchema = createInsertSchema(extractionsTable).omit({ id: true, createdAt: true });
export type InsertExtraction = z.infer<typeof insertExtractionSchema>;
export type Extraction = typeof extractionsTable.$inferSelect;

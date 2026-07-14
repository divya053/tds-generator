import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "./schema";

function resolveSqlitePath() {
  const configuredPath = process.env.SQLITE_DB_PATH ?? process.env.DATABASE_URL;
  if (configuredPath) {
    if (/^[a-z]+:\/\//i.test(configuredPath) && !configuredPath.startsWith("file:")) {
      return defaultSqlitePath();
    }

    return configuredPath.startsWith("file:")
      ? configuredPath.slice("file:".length)
      : configuredPath;
  }

  return defaultSqlitePath();
}

function defaultSqlitePath() {
  const currentFile = fileURLToPath(import.meta.url);
  return path.resolve(path.dirname(currentFile), "..", "..", "..", "data", "spec-extractor.sqlite");
}

const sqlitePath = resolveSqlitePath();
fs.mkdirSync(path.dirname(sqlitePath), { recursive: true });

const sqlite = new Database(sqlitePath);

sqlite.pragma("journal_mode = WAL");
sqlite.exec(`
  CREATE TABLE IF NOT EXISTS extractions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    filename TEXT NOT NULL,
    product_name TEXT NOT NULL,
    alternate_name TEXT NOT NULL DEFAULT '',
    product_description TEXT NOT NULL DEFAULT '',
    product_features TEXT NOT NULL DEFAULT '[]',
    application_areas TEXT NOT NULL DEFAULT '[]',
    technical_specs TEXT NOT NULL DEFAULT '[]',
    notes TEXT NOT NULL DEFAULT '[]',
    vendor_info TEXT NOT NULL DEFAULT '{"vendorName":"","vendorContact":""}',
    source_images TEXT NOT NULL DEFAULT '[]',
    source_pages TEXT NOT NULL DEFAULT '[]',
    raw_json TEXT,
    created_at INTEGER NOT NULL
  )
`);

type TableInfoRow = {
  name: string;
};

function ensureColumn(columnName: string, definition: string) {
  const columns = sqlite.prepare("PRAGMA table_info(extractions)").all() as TableInfoRow[];
  if (!columns.some((column) => column.name === columnName)) {
    sqlite.exec(`ALTER TABLE extractions ADD COLUMN ${columnName} ${definition}`);
  }
}

ensureColumn("source_images", `TEXT NOT NULL DEFAULT '[]'`);
ensureColumn("source_pages", `TEXT NOT NULL DEFAULT '[]'`);

export const db = drizzle(sqlite, { schema });

export * from "./schema";

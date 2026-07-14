import { defineConfig } from "drizzle-kit";
import path from "path";

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
  return path.resolve(__dirname, "..", "..", "data", "spec-extractor.sqlite");
}

export default defineConfig({
  schema: path.join(__dirname, "./src/schema/index.ts"),
  dialect: "sqlite",
  dbCredentials: {
    url: resolveSqlitePath(),
  },
});

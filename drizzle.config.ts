import { defineConfig } from "drizzle-kit";

// Dev-only helper (e.g. `drizzle-kit generate` to diff schema changes). Production uses the hand-reviewed
// SQL files in db/migrations, applied at boot by api/queries/migrate.ts.
export default defineConfig({
  schema: "./db/schema.ts",
  out: "./db/drizzle-scratch",
  dialect: "postgresql",
  schemaFilter: ["sarmaye"],
  dbCredentials: { url: process.env.DATABASE_URL ?? "" },
});

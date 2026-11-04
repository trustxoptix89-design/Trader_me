import { defineConfig } from "vitest/config";
import path from "path";

const templateRoot = path.resolve(import.meta.dirname);

export default defineConfig({
  root: templateRoot,
  resolve: {
    alias: {
      "@": path.resolve(templateRoot, "src"),
      "@contracts": path.resolve(templateRoot, "contracts"),
      "@db": path.resolve(templateRoot, "db"),
      "@assets": path.resolve(templateRoot, "attached_assets"),
    },
  },
  test: {
    environment: "node",
    // The DB_PROBE suites share one PostgreSQL database and some of them cut every other backend (pg_terminate_backend)
    // to simulate a network failure; running files in parallel makes them kill each other's connections.
    fileParallelism: false,
    include: ["api/**/*.test.ts", "api/**/*.spec.ts"],
  },
});

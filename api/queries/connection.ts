import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { env } from "../lib/env";
import * as schema from "@db/schema";
import * as relations from "@db/relations";

const fullSchema = { ...schema, ...relations };

let client: ReturnType<typeof postgres> | undefined;
let instance: ReturnType<typeof drizzle<typeof fullSchema>> | undefined;

/** Raw postgres.js client (shared by Drizzle and the migration runner). */
export function getSql() {
  if (!client) {
    if (!env.databaseUrl) throw new Error("DATABASE_URL is not configured");
    const url = new URL(env.databaseUrl);
    // Supabase's transaction pooler (port 6543) does not support prepared statements.
    const pooled = url.port === "6543" || url.hostname.includes("pooler.");
    client = postgres(env.databaseUrl, {
      max: 5,
      idle_timeout: 20,
      connect_timeout: 15,
      prepare: !pooled,
      ssl: url.hostname === "localhost" || url.hostname === "127.0.0.1" ? false : "require",
    });
  }
  return client;
}

export function getDb() {
  if (!instance) instance = drizzle(getSql(), { schema: fullSchema });
  return instance;
}

export async function closeDb() {
  await client?.end({ timeout: 5 });
  client = undefined;
  instance = undefined;
}

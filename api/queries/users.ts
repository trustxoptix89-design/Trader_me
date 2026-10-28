import { eq } from "drizzle-orm";
import * as schema from "@db/schema";
import type { InsertUser } from "@db/schema";
import { getDb } from "./connection";

export async function findUserByUnionId(unionId: string) {
  const rows = await getDb().select().from(schema.users).where(eq(schema.users.unionId, unionId)).limit(1);
  return rows.at(0);
}

export async function upsertUser(data: InsertUser) {
  await getDb()
    .insert(schema.users)
    .values(data)
    .onConflictDoUpdate({ target: schema.users.unionId, set: { ...data, lastSignInAt: new Date() } });
}

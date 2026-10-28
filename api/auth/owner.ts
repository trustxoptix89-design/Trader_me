import { createHash, timingSafeEqual } from "node:crypto";
import * as jose from "jose";
import * as cookie from "cookie";
import { Session } from "@contracts/constants";
import { Errors } from "@contracts/errors";
import { env } from "../lib/env";
import { findUserByUnionId, upsertUser } from "../queries/users";

export const OWNER_UNION_ID = "owner";
const JWT_ALG = "HS256";

/** Constant-time password comparison (hashes first so lengths never leak). */
export function passwordMatches(input: string, expected: string): boolean {
  if (!expected) return false;
  const a = createHash("sha256").update(input).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}

/** Fixed-window failure limiter, one bucket per key (in-process; fine for a single-instance personal deployment). */
export function createLimiter(maxFailures: number, windowMs: number, now: () => number = Date.now) {
  const buckets = new Map<string, { failures: number; resetAt: number }>();
  const live = (key: string) => {
    const b = buckets.get(key);
    if (!b || b.resetAt <= now()) { buckets.delete(key); return undefined; }
    return b;
  };
  return {
    blocked: (key: string) => (live(key)?.failures ?? 0) >= maxFailures,
    fail: (key: string) => {
      const b = live(key) ?? { failures: 0, resetAt: now() + windowMs };
      b.failures += 1; buckets.set(key, b);
    },
    reset: (key: string) => { buckets.delete(key); },
  };
}

export async function signSession(secret: string, unionId = OWNER_UNION_ID, now = Date.now()): Promise<string> {
  return new jose.SignJWT({ unionId })
    .setProtectedHeader({ alg: JWT_ALG })
    .setIssuedAt(Math.floor(now / 1000))
    .setExpirationTime(Math.floor((now + Session.maxAgeMs) / 1000))
    .sign(new TextEncoder().encode(secret));
}

export async function verifySession(secret: string, token: string): Promise<string | null> {
  try {
    const { payload } = await jose.jwtVerify(token, new TextEncoder().encode(secret), { algorithms: [JWT_ALG] });
    return typeof payload.unionId === "string" ? payload.unionId : null;
  } catch {
    return null;
  }
}

export async function ensureOwnerUser() {
  await upsertUser({ unionId: OWNER_UNION_ID, name: "Owner", role: "admin", lastSignInAt: new Date() });
  const user = await findUserByUnionId(OWNER_UNION_ID);
  if (!user) throw new Error("Owner user could not be created");
  return user;
}

export async function authenticateRequest(headers: Headers) {
  const token = cookie.parse(headers.get("cookie") || "")[Session.cookieName];
  if (!token || !env.sessionSecret) throw Errors.forbidden("Invalid authentication token.");
  const unionId = await verifySession(env.sessionSecret, token);
  if (!unionId) throw Errors.forbidden("Invalid authentication token.");
  const user = await findUserByUnionId(unionId);
  if (!user) throw Errors.forbidden("User not found. Please re-login.");
  return user;
}

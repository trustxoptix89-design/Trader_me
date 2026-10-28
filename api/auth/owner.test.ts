import { describe, expect, it } from "vitest";
import { createLimiter, passwordMatches, signSession, verifySession } from "./owner";

const SECRET = "x".repeat(40);

describe("owner password check", () => {
  it("accepts only the exact password and never an empty configuration", () => {
    expect(passwordMatches("correct horse battery", "correct horse battery")).toBe(true);
    expect(passwordMatches("correct horse batterY", "correct horse battery")).toBe(false);
    expect(passwordMatches("", "correct horse battery")).toBe(false);
    expect(passwordMatches("anything", "")).toBe(false);
    expect(passwordMatches("", "")).toBe(false);
  });
});

describe("session tokens", () => {
  it("round-trips, rejects tampering, a wrong secret and expiry", async () => {
    const token = await signSession(SECRET);
    expect(await verifySession(SECRET, token)).toBe("owner");
    expect(await verifySession("y".repeat(40), token)).toBeNull();
    expect(await verifySession(SECRET, token.slice(0, -2) + "xx")).toBeNull();
    expect(await verifySession(SECRET, "")).toBeNull();
    const old = await signSession(SECRET, "owner", Date.now() - 31 * 24 * 60 * 60 * 1000);
    expect(await verifySession(SECRET, old)).toBeNull();
  });
});

describe("login rate limiter", () => {
  it("blocks after the maximum failures, resets on success and expires with the window", () => {
    let now = 1_000;
    const limiter = createLimiter(3, 60_000, () => now);
    limiter.fail("ip"); limiter.fail("ip");
    expect(limiter.blocked("ip")).toBe(false);
    limiter.fail("ip");
    expect(limiter.blocked("ip")).toBe(true);
    expect(limiter.blocked("other")).toBe(false);
    now += 60_001;
    expect(limiter.blocked("ip")).toBe(false);
    limiter.fail("ip"); limiter.reset("ip");
    expect(limiter.blocked("ip")).toBe(false);
  });
});

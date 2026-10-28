import "dotenv/config";

function required(name: string, minLength = 1): string {
  const value = process.env[name];
  if (process.env.NODE_ENV === "production") {
    if (!value) throw new Error(`Missing required environment variable: ${name}`);
    if (value.length < minLength) throw new Error(`${name} must be at least ${minLength} characters`);
  }
  return value ?? "";
}

export const env = {
  isProduction: process.env.NODE_ENV === "production",
  databaseUrl: required("DATABASE_URL"),
  /** Owner login password. Single-user deployment: whoever knows it is the owner. */
  ownerPassword: required("OWNER_PASSWORD", 12),
  /** HMAC key for session cookies. */
  sessionSecret: required("SESSION_SECRET", 32),
};

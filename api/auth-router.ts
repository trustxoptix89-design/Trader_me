import * as cookie from "cookie";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { Session } from "@contracts/constants";
import { env } from "./lib/env";
import { getSessionCookieOptions } from "./lib/cookies";
import { createRouter, authedQuery, publicQuery } from "./middleware";
import { createLimiter, ensureOwnerUser, passwordMatches, signSession } from "./auth/owner";

const limiter = createLimiter(5, 15 * 60 * 1000);

function clientKey(headers: Headers) {
  return headers.get("x-forwarded-for")?.split(",")[0]?.trim() || headers.get("x-real-ip") || "local";
}

function sessionCookie(headers: Headers, value: string, maxAgeSeconds: number) {
  const opts = getSessionCookieOptions(headers);
  return cookie.serialize(Session.cookieName, value, {
    httpOnly: opts.httpOnly, path: opts.path, sameSite: "lax", secure: opts.secure, maxAge: maxAgeSeconds,
  });
}

export const authRouter = createRouter({
  me: publicQuery.query((opts) => opts.ctx.user ?? null),
  login: publicQuery.input(z.object({ password: z.string().min(1).max(256) })).mutation(async ({ ctx, input }) => {
    const key = clientKey(ctx.req.headers);
    if (limiter.blocked(key)) throw new TRPCError({ code: "TOO_MANY_REQUESTS", message: "تلاش‌های ناموفق زیاد بود؛ ۱۵ دقیقه بعد دوباره امتحان کنید." });
    if (!env.ownerPassword || !env.sessionSecret) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "رمز مالک یا SESSION_SECRET روی سرور تنظیم نشده است." });
    if (!passwordMatches(input.password, env.ownerPassword)) {
      limiter.fail(key);
      throw new TRPCError({ code: "UNAUTHORIZED", message: "رمز نادرست است." });
    }
    limiter.reset(key);
    const user = await ensureOwnerUser();
    const token = await signSession(env.sessionSecret, user.unionId);
    ctx.resHeaders.append("set-cookie", sessionCookie(ctx.req.headers, token, Session.maxAgeMs / 1000));
    return { success: true };
  }),
  logout: authedQuery.mutation(async ({ ctx }) => {
    ctx.resHeaders.append("set-cookie", sessionCookie(ctx.req.headers, "", 0));
    return { success: true };
  }),
});

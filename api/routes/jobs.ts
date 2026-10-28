import { Hono } from "hono";
import { runScheduler } from "../scheduler";

export const jobsRoutes = new Hono();

jobsRoutes.post("/run", async (c) => {
  const secret = process.env.CRON_SECRET;
  if (!secret) return c.json({ error: "CRON_SECRET is not configured; use the in-process scheduler" }, 503);
  if (c.req.header("authorization") !== `Bearer ${secret}`) return c.json({ error: "Unauthorized" }, 401);
  const result = await runScheduler();
  return c.json(result, result.ok ? 200 : 500);
});

jobsRoutes.get("/status", (c) => c.json({ running: true, delivery: "in-process interval and protected POST /api/jobs/run", realTrading: false }));

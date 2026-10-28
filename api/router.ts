import { authRouter } from "./auth-router";
import { createRouter, publicQuery } from "./middleware";
import { tradingRouter } from "./trading-router";

export const appRouter = createRouter({
  ping: publicQuery.query(() => ({ ok: true, ts: Date.now() })),
  auth: authRouter,
  trading: tradingRouter,

  // TODO: add feature routers here, e.g.
  // todo: createRouter({
  //   list: publicQuery.query(() => findTodos()),
  // }),
});

export type AppRouter = typeof appRouter;

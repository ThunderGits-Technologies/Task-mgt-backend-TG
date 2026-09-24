import express from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import { authRouter } from "./routes/auth";
import { usersRouter, acceptInviteHandler } from "./routes/users";
import { clientsRouter } from "./routes/clients";
import { contentItemsRouter } from "./routes/contentItems";
import { deliverablesRouter } from "./routes/deliverables";
import { reportsRouter } from "./routes/reports";
import { stagesRouter } from "./routes/stages";
import { assetsRouter } from "./routes/assets";
import { notificationsRouter } from "./routes/notifications";
import { errorHandler, asyncRoute } from "./middleware/errorHandler";

export function createApp() {
  const app = express();

  app.use(
    cors({
      origin: process.env.WEB_ORIGIN ?? "http://localhost:3000",
      credentials: true,
    }),
  );
  app.use(express.json());
  app.use(cookieParser());

  app.get("/health", (_req, res) => res.json({ ok: true }));

  app.use("/auth", authRouter);
  app.post("/auth/accept-invite", asyncRoute(acceptInviteHandler));
  app.use("/users", usersRouter);
  app.use("/clients", clientsRouter);
  app.use("/content-items", contentItemsRouter);
  app.use("/deliverables", deliverablesRouter);
  app.use("/reports", reportsRouter);
  app.use("/stages", stagesRouter);
  app.use("/", assetsRouter);
  app.use("/notifications", notificationsRouter);

  app.use(errorHandler);

  return app;
}

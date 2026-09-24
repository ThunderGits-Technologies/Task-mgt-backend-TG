import { Router } from "express";
import { asc, eq } from "drizzle-orm";
import { db } from "../db/client";
import { stages } from "../db/schema";
import { authenticate, requireActor } from "../middleware/auth";
import { asyncRoute } from "../middleware/errorHandler";

export const stagesRouter = Router();
stagesRouter.use(authenticate);

/** Every role can read the workspace's stage list — it's what drives the board columns. */
stagesRouter.get(
  "/",
  asyncRoute(async (req, res) => {
    const actor = requireActor(req);
    const rows = await db.select().from(stages).where(eq(stages.workspaceId, actor.workspaceId)).orderBy(asc(stages.order));
    return res.json({ stages: rows });
  }),
);

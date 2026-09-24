import { Router } from "express";
import { and, desc, eq } from "drizzle-orm";
import { db } from "../db/client";
import { notifications } from "../db/schema";
import { authenticate, requireActor } from "../middleware/auth";
import { asyncRoute, NotFoundError } from "../middleware/errorHandler";

export const notificationsRouter = Router();
notificationsRouter.use(authenticate);

notificationsRouter.get(
  "/",
  asyncRoute(async (req, res) => {
    const actor = requireActor(req);
    const rows = await db
      .select()
      .from(notifications)
      .where(eq(notifications.userId, actor.userId))
      .orderBy(desc(notifications.createdAt))
      .limit(30);
    const unreadCount = rows.filter((r) => !r.read).length;
    return res.json({ notifications: rows, unreadCount });
  }),
);

notificationsRouter.post(
  "/:id/read",
  asyncRoute(async (req, res) => {
    const actor = requireActor(req);
    const [row] = await db
      .select()
      .from(notifications)
      .where(and(eq(notifications.id, req.params.id), eq(notifications.userId, actor.userId)))
      .limit(1);
    if (!row) throw new NotFoundError("Notification not found");
    await db.update(notifications).set({ read: true }).where(eq(notifications.id, row.id));
    return res.status(204).send();
  }),
);

notificationsRouter.post(
  "/read-all",
  asyncRoute(async (req, res) => {
    const actor = requireActor(req);
    await db.update(notifications).set({ read: true }).where(eq(notifications.userId, actor.userId));
    return res.status(204).send();
  }),
);

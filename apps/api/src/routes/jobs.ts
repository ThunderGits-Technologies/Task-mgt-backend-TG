import { Router } from "express";
import { and, eq, gt, inArray, isNotNull, lte, ne } from "drizzle-orm";
import { db } from "../db/client";
import { deliverables, deliverableAssignees, stages, notifications } from "../db/schema";

/**
 * Scheduled jobs. These are called by an external scheduler (cron-job.org, GitHub Actions...),
 * not by logged-in users, so they are protected by a shared secret instead of a login.
 *
 * Set CRON_SECRET in the API's environment, and have the scheduler send it in the
 * `x-cron-secret` header.
 */
export const jobsRouter = Router();

const DAY = 24 * 60 * 60 * 1000;
const LOOKBACK_DAYS = 7; // don't alert about tasks that went overdue more than a week ago

function niceDate(d: Date) {
  return d.toLocaleDateString("en-GB", { timeZone: "UTC", day: "numeric", month: "short", year: "numeric" });
}

/**
 * Due dates are stored as midnight UTC of the due day, so a task counts as
 * - "due soon" from the day before until the due day ends, and
 * - "overdue" once the due day is over.
 * Each person gets each alert once per task and due date (checked against existing notifications).
 */
jobsRouter.post("/run-reminders", async (req, res) => {
  const secret = process.env.CRON_SECRET;
  if (!secret || req.header("x-cron-secret") !== secret) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  try {
    const now = Date.now();

    const tasks = await db
      .select({
        id: deliverables.id,
        title: deliverables.title,
        workspaceId: deliverables.workspaceId,
        ownerId: deliverables.ownerId,
        dueDate: deliverables.dueDate,
      })
      .from(deliverables)
      .innerJoin(stages, eq(stages.id, deliverables.stageId))
      .where(
        and(
          isNotNull(deliverables.dueDate),
          ne(stages.stageType, "done"),
          lte(deliverables.dueDate, new Date(now + DAY)),
          gt(deliverables.dueDate, new Date(now - (LOOKBACK_DAYS + 1) * DAY)),
        ),
      );

    if (tasks.length === 0) return res.json({ checked: 0, created: 0 });

    const taskIds = tasks.map((t) => t.id);
    const assigneeRows = await db
      .select({ deliverableId: deliverableAssignees.deliverableId, userId: deliverableAssignees.userId })
      .from(deliverableAssignees)
      .where(inArray(deliverableAssignees.deliverableId, taskIds));

    const links = taskIds.map((id) => `/deliverables/${id}`);
    const existing = await db
      .select({ userId: notifications.userId, type: notifications.type, link: notifications.link, body: notifications.body })
      .from(notifications)
      .where(and(inArray(notifications.type, ["task.due_soon", "task.overdue"]), inArray(notifications.link, links)));
    const alreadySent = new Set(existing.map((e) => `${e.userId}|${e.type}|${e.link}|${e.body}`));

    const toInsert: (typeof notifications.$inferInsert)[] = [];
    for (const task of tasks) {
      const due = task.dueDate as Date;
      const overdue = due.getTime() <= now - DAY;
      const type = overdue ? "task.overdue" : "task.due_soon";
      const link = `/deliverables/${task.id}`;
      const body = `Due ${niceDate(due)}`;
      const recipients = new Set([
        task.ownerId,
        ...assigneeRows.filter((a) => a.deliverableId === task.id).map((a) => a.userId),
      ]);
      for (const userId of recipients) {
        if (alreadySent.has(`${userId}|${type}|${link}|${body}`)) continue;
        toInsert.push({
          workspaceId: task.workspaceId,
          userId,
          type,
          title: overdue ? `Overdue: ${task.title}` : `Due soon: ${task.title}`,
          body,
          link,
        });
      }
    }

    if (toInsert.length > 0) await db.insert(notifications).values(toInsert);
    return res.json({ checked: tasks.length, created: toInsert.length });
  } catch (err) {
    console.error("run-reminders failed", err);
    return res.status(500).json({ error: "Reminder job failed" });
  }
});
import { Router } from "express";
import { and, eq, gte, inArray, lt, lte } from "drizzle-orm";
import { db } from "../db/client";
import { deliverables, deliverableAssignees, contentItems, clients, stages, stageTransitions } from "../db/schema";
import { authenticate, requireActor } from "../middleware/auth";
import { asyncRoute } from "../middleware/errorHandler";
import { policy } from "../policy/policy";
import type { ActorScope } from "../policy/actorScope";

export const reportsRouter = Router();
reportsRouter.use(authenticate);

const NONE_ID = "00000000-0000-0000-0000-000000000000";

/** Resolves the deliverable ids visible to this actor, honoring client scoping. */
async function scopedDeliverableIds(actor: ActorScope, clientId?: string): Promise<string[] | null> {
  if (clientId) {
    policy.assertCanViewClient(actor, clientId);
    const items = await db.select({ id: contentItems.id }).from(contentItems).where(eq(contentItems.clientId, clientId));
    const ids = items.map((i) => i.id);
    if (ids.length === 0) return [];
    const rows = await db.select({ id: deliverables.id }).from(deliverables).where(inArray(deliverables.contentItemId, ids));
    return rows.map((r) => r.id);
  }

  if (actor.role === "admin") return null; // no filter

  if (actor.role === "manager" || actor.role === "team_member") {
    const clientIds = Array.from(actor.assignedClientIds);
    if (clientIds.length === 0) return [];
    const items = await db.select({ id: contentItems.id }).from(contentItems).where(inArray(contentItems.clientId, clientIds));
    const ids = items.map((i) => i.id);
    if (ids.length === 0) return [];
    const rows = await db.select({ id: deliverables.id }).from(deliverables).where(inArray(deliverables.contentItemId, ids));
    return rows.map((r) => r.id);
  }

  if (actor.role === "client") {
    if (!actor.ownClientId) return [];
    const items = await db.select({ id: contentItems.id }).from(contentItems).where(eq(contentItems.clientId, actor.ownClientId));
    const ids = items.map((i) => i.id);
    if (ids.length === 0) return [];
    const rows = await db.select({ id: deliverables.id }).from(deliverables).where(inArray(deliverables.contentItemId, ids));
    return rows.map((r) => r.id);
  }

  // freelancer: only their own assignments
  const rows = await db.select({ deliverableId: deliverableAssignees.deliverableId }).from(deliverableAssignees).where(eq(deliverableAssignees.userId, actor.userId));
  return rows.map((r) => r.deliverableId);
}

/** RPT-01: deliverables per client by stage. */
reportsRouter.get(
  "/stage-summary",
  asyncRoute(async (req, res) => {
    const actor = requireActor(req);
    const clientId = req.query.clientId as string | undefined;
    const ids = await scopedDeliverableIds(actor, clientId);

    const conditions = [eq(deliverables.workspaceId, actor.workspaceId)];
    if (ids !== null) conditions.push(inArray(deliverables.id, ids.length > 0 ? ids : [NONE_ID]));

    const rows = await db.query.deliverables.findMany({
      where: and(...conditions),
      columns: {},
      with: { stage: { columns: { key: true, label: true } } },
    });

    const counts = new Map<string, { label: string; count: number }>();
    for (const d of rows) {
      const entry = counts.get(d.stage.key) ?? { label: d.stage.label, count: 0 };
      entry.count += 1;
      counts.set(d.stage.key, entry);
    }
    return res.json({ stages: Array.from(counts.entries()).map(([key, v]) => ({ key, ...v })) });
  }),
);

/** RPT-02: overdue items by client and by person. */
reportsRouter.get(
  "/overdue",
  asyncRoute(async (req, res) => {
    const actor = requireActor(req);
    const clientId = req.query.clientId as string | undefined;
    const ids = await scopedDeliverableIds(actor, clientId);

    const conditions = [eq(deliverables.workspaceId, actor.workspaceId), lt(deliverables.dueDate, new Date())];
    if (ids !== null) conditions.push(inArray(deliverables.id, ids.length > 0 ? ids : [NONE_ID]));

    const rows = await db.query.deliverables.findMany({
      where: and(...conditions),
      with: {
        stage: { columns: { label: true, stageType: true } },
        assignees: { with: { user: { columns: { id: true, name: true } } } },
      },
    });

    const overdue = rows.filter((d) => d.stage.stageType !== "done");
    return res.json({
      overdue: overdue.map((d) => ({
        id: d.id,
        title: d.title,
        dueDate: d.dueDate,
        stage: d.stage.label,
        assignees: d.assignees.map((a) => a.user.name),
      })),
    });
  }),
);

/** RPT-05: team workload (open deliverables per assignee). */
reportsRouter.get(
  "/workload",
  asyncRoute(async (req, res) => {
    const actor = requireActor(req);
    if (!(actor.role === "admin" || actor.role === "manager")) {
      return res.status(403).json({ error: "Workload across the team is a manager/admin report" });
    }

    const ids = await scopedDeliverableIds(actor);
    const conditions = ids !== null ? [inArray(deliverableAssignees.deliverableId, ids.length > 0 ? ids : [NONE_ID])] : [];

    const rows = await db.query.deliverableAssignees.findMany({
      where: conditions.length > 0 ? and(...conditions) : undefined,
      with: {
        user: { columns: { id: true, name: true, role: true } },
        deliverable: { with: { stage: { columns: { stageType: true } } } },
      },
    });

    const byUser = new Map<string, { name: string; role: string; openCount: number }>();
    for (const a of rows) {
      if (a.deliverable.stage.stageType === "done") continue;
      const entry = byUser.get(a.userId) ?? { name: a.user.name, role: a.user.role, openCount: 0 };
      entry.openCount += 1;
      byUser.set(a.userId, entry);
    }
    return res.json({ workload: Array.from(byUser.values()) });
  }),
);

/** RPT-03 groundwork: average time spent per stage, from the transition log. */
reportsRouter.get(
  "/stage-turnaround",
  asyncRoute(async (req, res) => {
    const actor = requireActor(req);
    if (!policy.canViewWorkspaceReports(actor) && actor.role !== "manager") {
      return res.status(403).json({ error: "Not permitted" });
    }
    const clientId = req.query.clientId as string | undefined;
    const ids = await scopedDeliverableIds(actor, clientId);

    const deliverableIds =
      ids !== null
        ? ids
        : (await db.select({ id: deliverables.id }).from(deliverables).where(eq(deliverables.workspaceId, actor.workspaceId))).map((d) => d.id);

    const transitions =
      deliverableIds.length === 0
        ? []
        : await db
            .select()
            .from(stageTransitions)
            .where(inArray(stageTransitions.deliverableId, deliverableIds))
            .orderBy(stageTransitions.deliverableId, stageTransitions.changedAt);

    const stageDurations = new Map<string, { totalMs: number; count: number }>();
    const byDeliverable = new Map<string, typeof transitions>();
    for (const t of transitions) {
      const list = byDeliverable.get(t.deliverableId) ?? [];
      list.push(t);
      byDeliverable.set(t.deliverableId, list);
    }
    for (const list of byDeliverable.values()) {
      for (let i = 0; i < list.length - 1; i++) {
        const stageKey = list[i].toStageId;
        const durationMs = list[i + 1].changedAt.getTime() - list[i].changedAt.getTime();
        const entry = stageDurations.get(stageKey) ?? { totalMs: 0, count: 0 };
        entry.totalMs += durationMs;
        entry.count += 1;
        stageDurations.set(stageKey, entry);
      }
    }

    const stageRows = await db.select().from(stages).where(eq(stages.workspaceId, actor.workspaceId));
    const stageLabel = new Map(stageRows.map((s) => [s.id, s.label]));

    return res.json({
      stageTurnaround: Array.from(stageDurations.entries()).map(([stageId, v]) => ({
        stageId,
        stageLabel: stageLabel.get(stageId) ?? stageId,
        averageHours: Math.round((v.totalMs / v.count / 1000 / 60 / 60) * 10) / 10,
        sampleSize: v.count,
      })),
    });
  }),
);

function toDateOnly(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * RPT-06/RPT-10 groundwork: a client x date grid of what's due, scheduled,
 * published or delayed — the same thing a "past 3 days / today / next 3
 * days" tracking sheet does by hand. Defaults to 3 days back through 3 days
 * forward, matching that habit, but `from`/`to` (YYYY-MM-DD) override it.
 */
reportsRouter.get(
  "/publishing-status",
  asyncRoute(async (req, res) => {
    const actor = requireActor(req);
    const { from, to } = req.query as Record<string, string | undefined>;

    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);
    const rangeStart = from ? new Date(from) : new Date(today.getTime() - 3 * 24 * 60 * 60 * 1000);
    const rangeEnd = to ? new Date(to) : new Date(today.getTime() + 3 * 24 * 60 * 60 * 1000);
    rangeEnd.setUTCHours(23, 59, 59, 999);

    const dates: string[] = [];
    for (let d = new Date(rangeStart); d <= rangeEnd; d = new Date(d.getTime() + 24 * 60 * 60 * 1000)) {
      dates.push(toDateOnly(d));
    }

    const clientConditions = [eq(clients.workspaceId, actor.workspaceId), eq(clients.archived, false)];
    if (actor.role === "manager" || actor.role === "team_member") {
      const ids = Array.from(actor.assignedClientIds);
      clientConditions.push(inArray(clients.id, ids.length > 0 ? ids : [NONE_ID]));
    } else if (actor.role === "client") {
      clientConditions.push(eq(clients.id, actor.ownClientId ?? NONE_ID));
    } else if (actor.role === "freelancer") {
      return res.json({ clients: [], dates, cells: {} }); // freelancers don't get a client-wide publishing view
    }
    // admin: no extra filter

    const visibleClients = await db
      .select({ id: clients.id, name: clients.name, brandColor: clients.brandColor })
      .from(clients)
      .where(and(...clientConditions))
      .orderBy(clients.name);
    if (visibleClients.length === 0) return res.json({ clients: [], dates, cells: {} });

    const items = await db
      .select()
      .from(contentItems)
      .where(
        and(
          eq(contentItems.workspaceId, actor.workspaceId),
          inArray(contentItems.clientId, visibleClients.map((c) => c.id)),
          gte(contentItems.publishDate, rangeStart),
          lte(contentItems.publishDate, rangeEnd),
        ),
      );

    const cells: Record<string, Record<string, { id: string; title: string; channel: string; format: string; status: string; computed: "published" | "delayed" | "scheduled" }[]>> = {};
    for (const client of visibleClients) {
      cells[client.id] = Object.fromEntries(dates.map((d) => [d, []]));
    }
    for (const item of items) {
      const dateKey = toDateOnly(item.publishDate);
      if (!cells[item.clientId]?.[dateKey]) continue;
      const isPast = item.publishDate < today;
      const computed: "published" | "delayed" | "scheduled" = item.status === "published" ? "published" : isPast ? "delayed" : "scheduled";
      cells[item.clientId][dateKey].push({ id: item.id, title: item.title, channel: item.channel, format: item.format, status: item.status, computed });
    }

    return res.json({ clients: visibleClients, dates, today: toDateOnly(today), cells });
  }),
);

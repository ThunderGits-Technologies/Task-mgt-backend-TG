import { Router } from "express";
import { z } from "zod";
import { and, eq, inArray } from "drizzle-orm";
import { db } from "../db/client";
import {
  deliverables,
  deliverableAssignees,
  contentItems,
  stages,
  stageTransitions,
  checklistItems,
  comments,
} from "../db/schema";
import { authenticate, requireActor } from "../middleware/auth";
import { asyncRoute, NotFoundError } from "../middleware/errorHandler";
import { policy } from "../policy/policy";
import type { ActorScope } from "../policy/actorScope";

export const deliverablesRouter = Router();
deliverablesRouter.use(authenticate);

const NONE_ID = "00000000-0000-0000-0000-000000000000";

/**
 * Resolves the clientId a deliverable belongs to, via its content item.
 * `found: false` means no such deliverable exists at all.
 * `found: true, clientId: null` means the deliverable exists but is
 * standalone (no linked content item) — never conflate this with "not found".
 */
async function getDeliverableClientId(deliverableId: string): Promise<{ found: boolean; clientId: string | null }> {
  const row = await db.query.deliverables.findFirst({
    where: eq(deliverables.id, deliverableId),
    with: { contentItem: { columns: { clientId: true } } },
  });
  if (!row) return { found: false, clientId: null };
  return { found: true, clientId: row.contentItem?.clientId ?? null };
}

/**
 * Standalone deliverables (clientId === null) have no client to scope
 * against. Only staff (admin/manager/team_member) can create them, so any
 * staff member may view/edit them; freelancers fall back to their direct
 * assignment; clients never see standalone deliverables.
 */
function canActOnStandalone(actor: ActorScope, kind: "view" | "edit", deliverableId: string): boolean {
  if (actor.role === "admin" || actor.role === "manager" || actor.role === "team_member") return true;
  if (actor.role === "freelancer") return actor.assignedDeliverableIds.has(deliverableId);
  return false; // client
}

/** Deliverable ids visible to this actor by client scope (staff/client roles). Null = "no extra filter (admin)". */
async function visibleDeliverableIdsByClient(actor: ActorScope): Promise<string[] | null> {
  if (actor.role === "admin") return null;

  let clientIds: string[];
  if (actor.role === "manager" || actor.role === "team_member") {
    clientIds = Array.from(actor.assignedClientIds);
  } else if (actor.role === "client") {
    clientIds = actor.ownClientId ? [actor.ownClientId] : [];
  } else {
    return []; // freelancer path handled by direct assignment filter, not here
  }
  if (clientIds.length === 0) return [];

  const items = await db.select({ id: contentItems.id }).from(contentItems).where(inArray(contentItems.clientId, clientIds));
  const contentItemIds = items.map((i) => i.id);
  if (contentItemIds.length === 0) return [];

  const rows = await db.select({ id: deliverables.id }).from(deliverables).where(inArray(deliverables.contentItemId, contentItemIds));
  return rows.map((r) => r.id);
}

deliverablesRouter.get(
  "/",
  asyncRoute(async (req, res) => {
    const actor = requireActor(req);
    const { stageId, assigneeId, clientId } = req.query as Record<string, string | undefined>;

    const conditions = [eq(deliverables.workspaceId, actor.workspaceId)];
    if (stageId) conditions.push(eq(deliverables.stageId, stageId));

    if (clientId) {
      policy.assertCanViewClient(actor, clientId);
      const items = await db.select({ id: contentItems.id }).from(contentItems).where(eq(contentItems.clientId, clientId));
      const ids = items.map((i) => i.id);
      conditions.push(inArray(deliverables.contentItemId, ids.length > 0 ? ids : [NONE_ID]));
    }

    let assigneeFilterUserId: string | undefined = assigneeId;
    if (actor.role === "freelancer") {
      assigneeFilterUserId = actor.userId; // freelancers only ever see their own assignments
    } else if (!clientId) {
      const visibleIds = await visibleDeliverableIdsByClient(actor);
      if (visibleIds !== null) {
        conditions.push(inArray(deliverables.id, visibleIds.length > 0 ? visibleIds : [NONE_ID]));
      }
    }

    let deliverableIdsForAssignee: string[] | undefined;
    if (assigneeFilterUserId) {
      const rows = await db
        .select({ deliverableId: deliverableAssignees.deliverableId })
        .from(deliverableAssignees)
        .where(eq(deliverableAssignees.userId, assigneeFilterUserId));
      deliverableIdsForAssignee = rows.map((r) => r.deliverableId);
      conditions.push(inArray(deliverables.id, deliverableIdsForAssignee.length > 0 ? deliverableIdsForAssignee : [NONE_ID]));
    }

    const rows = await db.query.deliverables.findMany({
      where: and(...conditions),
      with: {
        stage: true,
        assignees: { with: { user: { columns: { id: true, name: true } } } },
        contentItem: { columns: { id: true, title: true, clientId: true } },
      },
      orderBy: (t, { asc: ascOp }) => [ascOp(t.dueDate)],
    });

    return res.json({ deliverables: rows });
  }),
);

const createDeliverableSchema = z.object({
  contentItemId: z.string().uuid().optional(),
  title: z.string().min(2).max(200),
  description: z.string().max(4000).optional(),
  dueDate: z.coerce.date().optional(),
  priority: z.enum(["low", "medium", "high", "urgent"]).default("medium"),
  stageId: z.string().uuid(),
  ownerId: z.string().uuid(),
  assigneeIds: z.array(z.string().uuid()).default([]),
  parentId: z.string().uuid().optional(),
  blockedById: z.string().uuid().optional(),
});

deliverablesRouter.post(
  "/",
  asyncRoute(async (req, res) => {
    const actor = requireActor(req);
    const body = createDeliverableSchema.parse(req.body);

    if (body.contentItemId) {
      const [contentItem] = await db
        .select()
        .from(contentItems)
        .where(and(eq(contentItems.id, body.contentItemId), eq(contentItems.workspaceId, actor.workspaceId)))
        .limit(1);
      if (!contentItem) throw new NotFoundError("Content item not found");
      if (!(actor.role === "admin" || ((actor.role === "manager" || actor.role === "team_member") && actor.assignedClientIds.has(contentItem.clientId)))) {
        return res.status(403).json({ error: "You cannot add deliverables to this client's content" });
      }
    } else if (!(actor.role === "admin" || actor.role === "manager" || actor.role === "team_member")) {
      return res.status(403).json({ error: "Only staff can create standalone deliverables" });
    }

    const [stage] = await db
      .select()
      .from(stages)
      .where(and(eq(stages.id, body.stageId), eq(stages.workspaceId, actor.workspaceId)))
      .limit(1);
    if (!stage) throw new NotFoundError("Stage not found");

    const deliverable = await db.transaction(async (tx) => {
      const [created] = await tx
        .insert(deliverables)
        .values({
          workspaceId: actor.workspaceId,
          contentItemId: body.contentItemId,
          title: body.title,
          description: body.description,
          dueDate: body.dueDate,
          priority: body.priority,
          stageId: body.stageId,
          ownerId: body.ownerId,
          parentId: body.parentId,
          blockedById: body.blockedById,
        })
        .returning();

      if (body.assigneeIds.length > 0) {
        await tx.insert(deliverableAssignees).values(body.assigneeIds.map((userId) => ({ deliverableId: created.id, userId })));
      }

      await tx.insert(stageTransitions).values({ deliverableId: created.id, toStageId: created.stageId, changedById: actor.userId });

      return created;
    });

    return res.status(201).json({ deliverable });
  }),
);

deliverablesRouter.get(
  "/:id",
  asyncRoute(async (req, res) => {
    const actor = requireActor(req);
    const deliverable = await db.query.deliverables.findFirst({
      where: and(eq(deliverables.id, req.params.id), eq(deliverables.workspaceId, actor.workspaceId)),
      with: {
        stage: true,
        assignees: { with: { user: { columns: { id: true, name: true } } } },
        checklistItems: true,
        contentItem: { columns: { id: true, title: true, clientId: true } },
      },
    });
    if (!deliverable) throw new NotFoundError("Deliverable not found");

    const clientId = deliverable.contentItem?.clientId ?? null;
    if (clientId === null) {
      if (!canActOnStandalone(actor, "view", deliverable.id)) {
        return res.status(403).json({ error: "You do not have access to this deliverable" });
      }
    } else {
      policy.assertCanViewDeliverable(actor, { clientId, deliverableId: deliverable.id });
    }

    return res.json({ deliverable });
  }),
);

const updateDeliverableSchema = z.object({
  title: z.string().min(2).max(200).optional(),
  description: z.string().max(4000).optional(),
  dueDate: z.coerce.date().nullable().optional(),
  priority: z.enum(["low", "medium", "high", "urgent"]).optional(),
  stageId: z.string().uuid().optional(),
});

deliverablesRouter.patch(
  "/:id",
  asyncRoute(async (req, res) => {
    const actor = requireActor(req);
    const existing = await db.query.deliverables.findFirst({
      where: and(eq(deliverables.id, req.params.id), eq(deliverables.workspaceId, actor.workspaceId)),
      with: {
        contentItem: { columns: { clientId: true } },
        blockedBy: { with: { stage: true } },
      },
    });
    if (!existing) throw new NotFoundError("Deliverable not found");

    const clientId = existing.contentItem?.clientId ?? null;
    if (clientId === null) {
      if (!canActOnStandalone(actor, "edit", existing.id)) {
        return res.status(403).json({ error: "You cannot edit this deliverable" });
      }
    } else {
      policy.assertCanEditDeliverable(actor, { clientId, deliverableId: existing.id });
    }

    const body = updateDeliverableSchema.parse(req.body);

    if (body.stageId && body.stageId !== existing.stageId) {
      const [nextStage] = await db
        .select()
        .from(stages)
        .where(and(eq(stages.id, body.stageId), eq(stages.workspaceId, actor.workspaceId)))
        .limit(1);
      if (!nextStage) throw new NotFoundError("Stage not found");

      // Dependency enforcement (TSK-04): can't move out of backlog/blocked
      // state while the predecessor this task depends on isn't done yet.
      if (existing.blockedBy && existing.blockedBy.stage.stageType !== "done" && nextStage.stageType !== "backlog") {
        return res.status(409).json({
          error: `Blocked: "${existing.blockedById}" must reach Approved/Done before this can move to ${nextStage.label}`,
        });
      }
    }

    const updated = await db.transaction(async (tx) => {
      const [result] = await tx.update(deliverables).set(body).where(eq(deliverables.id, existing.id)).returning();
      if (body.stageId && body.stageId !== existing.stageId) {
        await tx.insert(stageTransitions).values({
          deliverableId: existing.id,
          fromStageId: existing.stageId,
          toStageId: body.stageId,
          changedById: actor.userId,
        });
      }
      return result;
    });

    return res.json({ deliverable: updated });
  }),
);

deliverablesRouter.delete(
  "/:id",
  asyncRoute(async (req, res) => {
    const actor = requireActor(req);
    const existing = await db.query.deliverables.findFirst({
      where: and(eq(deliverables.id, req.params.id), eq(deliverables.workspaceId, actor.workspaceId)),
      with: { contentItem: { columns: { clientId: true } } },
    });
    if (!existing) throw new NotFoundError("Deliverable not found");

    const clientId = existing.contentItem?.clientId ?? null;
    if (clientId === null) {
      if (!canActOnStandalone(actor, "edit", existing.id)) {
        return res.status(403).json({ error: "You cannot delete this deliverable" });
      }
    } else {
      policy.assertCanEditDeliverable(actor, { clientId, deliverableId: existing.id });
    }

    await db.delete(deliverables).where(eq(deliverables.id, existing.id));
    return res.status(204).send();
  }),
);

const assigneeSchema = z.object({ userId: z.string().uuid() });

deliverablesRouter.post(
  "/:id/assignees",
  asyncRoute(async (req, res) => {
    const actor = requireActor(req);
    const result = await getDeliverableClientId(req.params.id);
    if (!result.found) throw new NotFoundError("Deliverable not found");

    if (result.clientId === null) {
      if (!(actor.role === "admin" || actor.role === "manager" || actor.role === "team_member")) {
        return res.status(403).json({ error: "You cannot assign people to this deliverable" });
      }
    } else if (!(actor.role === "admin" || (actor.role === "manager" && actor.assignedClientIds.has(result.clientId)))) {
      return res.status(403).json({ error: "You cannot assign people to this deliverable" });
    }

    const body = assigneeSchema.parse(req.body);
    await db
      .insert(deliverableAssignees)
      .values({ deliverableId: req.params.id, userId: body.userId })
      .onConflictDoNothing({ target: [deliverableAssignees.deliverableId, deliverableAssignees.userId] });
    return res.status(201).json({ ok: true });
  }),
);

const checklistItemSchema = z.object({ label: z.string().min(1).max(300) });

deliverablesRouter.post(
  "/:id/checklist-items",
  asyncRoute(async (req, res) => {
    const actor = requireActor(req);
    const result = await getDeliverableClientId(req.params.id);
    if (!result.found) throw new NotFoundError("Deliverable not found");

    if (result.clientId === null) {
      if (!canActOnStandalone(actor, "edit", req.params.id)) {
        return res.status(403).json({ error: "You cannot edit this deliverable" });
      }
    } else {
      policy.assertCanEditDeliverable(actor, { clientId: result.clientId, deliverableId: req.params.id });
    }

    const body = checklistItemSchema.parse(req.body);
    const existingCount = await db.select({ id: checklistItems.id }).from(checklistItems).where(eq(checklistItems.deliverableId, req.params.id));
    const [item] = await db
      .insert(checklistItems)
      .values({ deliverableId: req.params.id, label: body.label, order: existingCount.length })
      .returning();
    return res.status(201).json({ checklistItem: item });
  }),
);

deliverablesRouter.patch(
  "/checklist-items/:itemId",
  asyncRoute(async (req, res) => {
    const actor = requireActor(req);
    const [item] = await db.select().from(checklistItems).where(eq(checklistItems.id, req.params.itemId)).limit(1);
    if (!item) throw new NotFoundError("Checklist item not found");

    const result = await getDeliverableClientId(item.deliverableId);
    if (!result.found) throw new NotFoundError("Deliverable not found");

    if (result.clientId === null) {
      if (!canActOnStandalone(actor, "edit", item.deliverableId)) {
        return res.status(403).json({ error: "You cannot edit this deliverable" });
      }
    } else {
      policy.assertCanEditDeliverable(actor, { clientId: result.clientId, deliverableId: item.deliverableId });
    }

    const body = z.object({ done: z.boolean() }).parse(req.body);
    const [updated] = await db.update(checklistItems).set({ done: body.done }).where(eq(checklistItems.id, item.id)).returning();
    return res.json({ checklistItem: updated });
  }),
);

const commentSchema = z.object({
  body: z.string().min(1).max(4000),
  visibility: z.enum(["internal", "client_visible"]).default("internal"),
});

deliverablesRouter.post(
  "/:id/comments",
  asyncRoute(async (req, res) => {
    const actor = requireActor(req);
    const result = await getDeliverableClientId(req.params.id);
    if (!result.found) throw new NotFoundError("Deliverable not found");

    if (result.clientId === null) {
      if (!canActOnStandalone(actor, "view", req.params.id)) {
        return res.status(403).json({ error: "You do not have access to this deliverable" });
      }
    } else {
      policy.assertCanViewDeliverable(actor, { clientId: result.clientId, deliverableId: req.params.id });
    }

    const body = commentSchema.parse(req.body);
    if (actor.role === "client" && body.visibility === "internal") {
      return res.status(403).json({ error: "Clients can only post client-visible comments" });
    }

    const [comment] = await db
      .insert(comments)
      .values({ deliverableId: req.params.id, authorId: actor.userId, body: body.body, visibility: body.visibility })
      .returning();
    return res.status(201).json({ comment });
  }),
);

deliverablesRouter.get(
  "/:id/comments",
  asyncRoute(async (req, res) => {
    const actor = requireActor(req);
    const result = await getDeliverableClientId(req.params.id);
    if (!result.found) throw new NotFoundError("Deliverable not found");

    if (result.clientId === null) {
      if (!canActOnStandalone(actor, "view", req.params.id)) {
        return res.status(403).json({ error: "You do not have access to this deliverable" });
      }
    } else {
      policy.assertCanViewDeliverable(actor, { clientId: result.clientId, deliverableId: req.params.id });
    }

    const conditions = [eq(comments.deliverableId, req.params.id)];
    // Internal notes are never sent to a client, even if they somehow guess
    // a comment id — filtered at the query level, not just hidden in the UI.
    if (!policy.canViewInternalComments(actor)) {
      conditions.push(eq(comments.visibility, "client_visible"));
    }

    const rows = await db.query.comments.findMany({
      where: and(...conditions),
      with: { author: { columns: { id: true, name: true, role: true } } },
      orderBy: (t, { asc: ascOp }) => [ascOp(t.createdAt)],
    });
    return res.json({ comments: rows });
  }),
);
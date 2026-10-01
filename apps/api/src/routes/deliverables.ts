
// import { Router } from "express";
// import { z } from "zod";
// import { and, asc, eq, inArray, isNotNull, or } from "drizzle-orm";
// import { db } from "../db/client";
// import {
//   deliverables,
//   deliverableAssignees,
//   contentItems,
//   clients,
//   stages,
//   stageTransitions,
//   checklistItems,
//   checklists,
//   lists,
//   comments,
// } from "../db/schema";
// import { authenticate, requireActor } from "../middleware/auth";
// import { asyncRoute, NotFoundError } from "../middleware/errorHandler";
// import { policy, ForbiddenError } from "../policy/policy";
// import type { ActorScope } from "../policy/actorScope";

// export const deliverablesRouter = Router();
// deliverablesRouter.use(authenticate);

// const NONE_ID = "00000000-0000-0000-0000-000000000000";

// /**
//  * Resolves the clientId a deliverable belongs to.
//  * A direct deliverables.clientId wins; otherwise fall back to the client of
//  * its linked content item (older tasks).
//  * `found: false` means no such deliverable exists at all.
//  * `found: true, clientId: null` means the deliverable exists but is
//  * standalone (no client at all) — never conflate this with "not found".
//  */
// async function getDeliverableClientId(deliverableId: string): Promise<{ found: boolean; clientId: string | null }> {
//   const row = await db.query.deliverables.findFirst({
//     where: eq(deliverables.id, deliverableId),
//     with: { contentItem: { columns: { clientId: true } } },
//   });
//   if (!row) return { found: false, clientId: null };
//   return { found: true, clientId: row.clientId ?? row.contentItem?.clientId ?? null };
// }

// /**
//  * Standalone deliverables (clientId === null) have no client to scope
//  * against. Only staff (admin/manager/team_member) can create them, so any
//  * staff member may view/edit them; freelancers fall back to their direct
//  * assignment; clients never see standalone deliverables.
//  */
// function canActOnStandalone(actor: ActorScope, kind: "view" | "edit", deliverableId: string): boolean {
//   if (actor.role === "admin" || actor.role === "manager" || actor.role === "team_member") return true;
//   if (actor.role === "freelancer") return actor.assignedDeliverableIds.has(deliverableId);
//   return false; // client
// }

// /** Can this actor attach work to this client? (admin: any; manager/team_member: assigned clients only) */
// function canUseClient(actor: ActorScope, clientId: string): boolean {
//   if (actor.role === "admin") return true;
//   if (actor.role === "manager" || actor.role === "team_member") return actor.assignedClientIds.has(clientId);
//   return false;
// }

// /** Throws NotFoundError unless the client exists in the actor's workspace. */
// async function assertClientInWorkspace(clientId: string, workspaceId: string) {
//   const [client] = await db
//     .select({ id: clients.id })
//     .from(clients)
//     .where(and(eq(clients.id, clientId), eq(clients.workspaceId, workspaceId)))
//     .limit(1);
//   if (!client) throw new NotFoundError("Client not found");
// }

// /** Deliverable ids visible to this actor by client scope (staff/client roles). Null = "no extra filter (admin)". */
// /** Deliverable ids visible to this actor by client scope (staff/client roles). Null = "no extra filter (admin)". */
// /** Deliverable ids visible to this actor by client scope (staff/client roles). Null = "no extra filter (admin)". */
// async function visibleDeliverableIdsByClient(actor: ActorScope): Promise<string[] | null> {
//   if (actor.role === "admin") return null;

//   if (actor.role === "team_member" || actor.role === "freelancer") {
//     // Strict isolation: see only tasks personally assigned to you, never a
//     // teammate's task on the same client.
//     const rows = await db
//       .select({ id: deliverableAssignees.deliverableId })
//       .from(deliverableAssignees)
//       .where(eq(deliverableAssignees.userId, actor.userId));
//     return rows.map((r) => r.id);
//   }

//   let clientIds: string[];
//   if (actor.role === "manager") {
//     clientIds = Array.from(actor.assignedClientIds);
//   } else if (actor.role === "client") {
//     clientIds = actor.ownClientId ? [actor.ownClientId] : [];
//   } else {
//     return [];
//   }
//   if (clientIds.length === 0 && actor.role !== "manager") return [];

//   const items = clientIds.length > 0
//     ? await db.select({ id: contentItems.id }).from(contentItems).where(inArray(contentItems.clientId, clientIds))
//     : [];
//   const contentItemIds = items.map((i) => i.id);

//   const rows = await db
//     .select({ id: deliverables.id })
//     .from(deliverables)
//     .where(
//       or(
//         clientIds.length > 0 ? inArray(deliverables.clientId, clientIds) : undefined,
//         contentItemIds.length > 0 ? inArray(deliverables.contentItemId, contentItemIds) : undefined,
//         // Tasks filed in a List belong to the internal hierarchy: managers see them all.
//         actor.role === "manager" ? isNotNull(deliverables.listId) : undefined,
//       ),
//     );
//   return rows.map((r) => r.id);
// }

// deliverablesRouter.get(
//   "/",
//   asyncRoute(async (req, res) => {
//     const actor = requireActor(req);
//     const { stageId, assigneeId, clientId, listId, folderId, spaceId } = req.query as Record<string, string | undefined>;

//     const conditions = [eq(deliverables.workspaceId, actor.workspaceId)];
//     if (stageId) conditions.push(eq(deliverables.stageId, stageId));

//     // Hierarchy filters: a List, every List in a Folder, or every List in a Space.
//     if (listId) {
//       conditions.push(eq(deliverables.listId, listId));
//     } else if (folderId || spaceId) {
//       const scope = await db
//         .select({ id: lists.id })
//         .from(lists)
//         .where(and(eq(lists.workspaceId, actor.workspaceId), folderId ? eq(lists.folderId, folderId) : eq(lists.spaceId, spaceId!)));
//       const ids = scope.map((l) => l.id);
//       conditions.push(inArray(deliverables.listId, ids.length > 0 ? ids : [NONE_ID]));
//     }

//     if (clientId) {
//       policy.assertCanViewClient(actor, clientId);
//       const items = await db.select({ id: contentItems.id }).from(contentItems).where(eq(contentItems.clientId, clientId));
//       const ids = items.map((i) => i.id);
//       conditions.push(
//         or(
//           eq(deliverables.clientId, clientId),
//           inArray(deliverables.contentItemId, ids.length > 0 ? ids : [NONE_ID]),
//         )!,
//       );
//     }

//     let assigneeFilterUserId: string | undefined = assigneeId;
//     if (actor.role === "freelancer") {
//       assigneeFilterUserId = actor.userId; // freelancers only ever see their own assignments
//     } else if (!clientId) {
//       const visibleIds = await visibleDeliverableIdsByClient(actor);
//       if (visibleIds !== null) {
//         conditions.push(inArray(deliverables.id, visibleIds.length > 0 ? visibleIds : [NONE_ID]));
//       }
//     }

//     let deliverableIdsForAssignee: string[] | undefined;
//     if (assigneeFilterUserId) {
//       const rows = await db
//         .select({ deliverableId: deliverableAssignees.deliverableId })
//         .from(deliverableAssignees)
//         .where(eq(deliverableAssignees.userId, assigneeFilterUserId));
//       deliverableIdsForAssignee = rows.map((r) => r.deliverableId);
//       conditions.push(inArray(deliverables.id, deliverableIdsForAssignee.length > 0 ? deliverableIdsForAssignee : [NONE_ID]));
//     }

//     const rows = await db.query.deliverables.findMany({
//       where: and(...conditions),
//       with: {
//         stage: true,
//         assignees: { with: { user: { columns: { id: true, name: true } } } },
//         contentItem: { columns: { id: true, title: true, clientId: true } },
//         client: { columns: { id: true, name: true } },
//         list: { columns: { id: true, name: true, spaceId: true, folderId: true } },
//       },
//       orderBy: (t, { asc: ascOp }) => [ascOp(t.dueDate)],
//     });

//     return res.json({ deliverables: rows });
//   }),
// );

// const createDeliverableSchema = z.object({
//   contentItemId: z.string().uuid().optional(),
//   clientId: z.string().uuid().optional(),
//   title: z.string().min(2).max(200),
//   description: z.string().max(4000).optional(),
//   dueDate: z.coerce.date().optional(),
//   priority: z.enum(["low", "medium", "high", "urgent"]).default("medium"),
//   stageId: z.string().uuid(),
//   ownerId: z.string().uuid(),
//   assigneeIds: z.array(z.string().uuid()).default([]),
//   parentId: z.string().uuid().optional(),
//   blockedById: z.string().uuid().optional(),
//   listId: z.string().uuid().optional(),
// });

// deliverablesRouter.post(
//   "/",
//   asyncRoute(async (req, res) => {
//     const actor = requireActor(req);
//     const body = createDeliverableSchema.parse(req.body);

//     let resolvedClientId: string | undefined = body.clientId;
//     let resolvedListId: string | undefined = body.listId;

//     // Subtasks (to any depth): must hang off a task in this workspace and inherit its List / client.
//     if (body.parentId) {
//       const [parent] = await db
//         .select()
//         .from(deliverables)
//         .where(and(eq(deliverables.id, body.parentId), eq(deliverables.workspaceId, actor.workspaceId)))
//         .limit(1);
//       if (!parent) throw new NotFoundError("Parent task not found");
//       await assertCanEditById(actor, parent.id);
//       resolvedListId = parent.listId ?? undefined;
//       resolvedClientId = body.clientId ?? parent.clientId ?? undefined;
//     }

//     if (resolvedListId) {
//       const [list] = await db
//         .select({ id: lists.id })
//         .from(lists)
//         .where(and(eq(lists.id, resolvedListId), eq(lists.workspaceId, actor.workspaceId)))
//         .limit(1);
//       if (!list) throw new NotFoundError("List not found");
//     }

//     if (body.contentItemId) {
//       const [contentItem] = await db
//         .select()
//         .from(contentItems)
//         .where(and(eq(contentItems.id, body.contentItemId), eq(contentItems.workspaceId, actor.workspaceId)))
//         .limit(1);
//       if (!contentItem) throw new NotFoundError("Content item not found");
//       if (!canUseClient(actor, contentItem.clientId)) {
//         return res.status(403).json({ error: "You cannot add deliverables to this client's content" });
//       }
//       if (body.clientId && body.clientId !== contentItem.clientId) {
//         return res.status(400).json({ error: "The selected client does not match the content item's client" });
//       }
//       resolvedClientId = contentItem.clientId;
//     } else if (body.clientId) {
//       await assertClientInWorkspace(body.clientId, actor.workspaceId);
//       if (!canUseClient(actor, body.clientId)) {
//         return res.status(403).json({ error: "You cannot add deliverables to this client" });
//       }
//     } else if (!(actor.role === "admin" || actor.role === "manager" || actor.role === "team_member")) {
//       return res.status(403).json({ error: "Only staff can create standalone deliverables" });
//     }

//     const [stage] = await db
//       .select()
//       .from(stages)
//       .where(and(eq(stages.id, body.stageId), eq(stages.workspaceId, actor.workspaceId)))
//       .limit(1);
//     if (!stage) throw new NotFoundError("Stage not found");

//     const deliverable = await db.transaction(async (tx) => {
//       const [created] = await tx
//         .insert(deliverables)
//         .values({
//           workspaceId: actor.workspaceId,
//           contentItemId: body.contentItemId,
//           clientId: resolvedClientId,
//           listId: resolvedListId,
//           title: body.title,
//           description: body.description,
//           dueDate: body.dueDate,
//           priority: body.priority,
//           stageId: body.stageId,
//           ownerId: body.ownerId,
//           parentId: body.parentId,
//           blockedById: body.blockedById,
//         })
//         .returning();

//       // Team members only see tasks assigned to them, so a task they create must include them.
//       const assigneeIds =
//         actor.role === "team_member" && !body.assigneeIds.includes(actor.userId)
//           ? [...body.assigneeIds, actor.userId]
//           : body.assigneeIds;
//       if (assigneeIds.length > 0) {
//         await tx.insert(deliverableAssignees).values(assigneeIds.map((userId) => ({ deliverableId: created.id, userId })));
//       }

//       await tx.insert(stageTransitions).values({ deliverableId: created.id, toStageId: created.stageId, changedById: actor.userId });

//       return created;
//     });

//     return res.status(201).json({ deliverable });
//   }),
// );

// deliverablesRouter.get(
//   "/:id",
//   asyncRoute(async (req, res) => {
//     const actor = requireActor(req);
//     const deliverable = await db.query.deliverables.findFirst({
//       where: and(eq(deliverables.id, req.params.id), eq(deliverables.workspaceId, actor.workspaceId)),
//       with: {
//         stage: true,
//         assignees: { with: { user: { columns: { id: true, name: true } } } },
//         checklistItems: true,
//         contentItem: { columns: { id: true, title: true, clientId: true } },
//         client: { columns: { id: true, name: true } },
//       },
//     });
//     if (!deliverable) throw new NotFoundError("Deliverable not found");

//     const clientId = deliverable.clientId ?? deliverable.contentItem?.clientId ?? null;
//     if (clientId === null) {
//       if (!canActOnStandalone(actor, "view", deliverable.id)) {
//         return res.status(403).json({ error: "You do not have access to this deliverable" });
//       }
//     } else {
//       policy.assertCanViewDeliverable(actor, { clientId, deliverableId: deliverable.id });
//     }

//     const [checklistRows, itemRows, subtasks, list] = await Promise.all([
//       db.select().from(checklists).where(eq(checklists.deliverableId, deliverable.id)).orderBy(asc(checklists.order), asc(checklists.createdAt)),
//       db.select().from(checklistItems).where(eq(checklistItems.deliverableId, deliverable.id)).orderBy(asc(checklistItems.order)),
//       db.query.deliverables.findMany({
//         where: and(eq(deliverables.parentId, deliverable.id), eq(deliverables.workspaceId, actor.workspaceId)),
//         with: {
//           stage: true,
//           assignees: { with: { user: { columns: { id: true, name: true } } } },
//         },
//         orderBy: (t, { asc: ascOp }) => [ascOp(t.createdAt)],
//       }),
//       deliverable.listId
//         ? db.query.lists.findFirst({
//             where: eq(lists.id, deliverable.listId),
//             with: {
//               space: { columns: { id: true, name: true } },
//               folder: { columns: { id: true, name: true } },
//             },
//           })
//         : Promise.resolve(null),
//     ]);

//     // Walk up parentId to build the breadcrumb (guarded against accidental cycles).
//     const ancestors: { id: string; title: string }[] = [];
//     let cursor = deliverable.parentId;
//     for (let depth = 0; cursor && depth < 20; depth++) {
//       const [parent] = await db
//         .select({ id: deliverables.id, title: deliverables.title, parentId: deliverables.parentId })
//         .from(deliverables)
//         .where(and(eq(deliverables.id, cursor), eq(deliverables.workspaceId, actor.workspaceId)))
//         .limit(1);
//       if (!parent) break;
//       ancestors.unshift({ id: parent.id, title: parent.title });
//       cursor = parent.parentId;
//     }

//     return res.json({
//       deliverable: {
//         ...deliverable,
//         list: list ?? null,
//         subtasks,
//         ancestors,
//         // Named checklists, each with its items. Legacy ungrouped items are returned as one "Checklist".
//         checklists: [
//           ...checklistRows.map((c) => ({ id: c.id, name: c.name, items: itemRows.filter((i) => i.checklistId === c.id) })),
//           ...(itemRows.some((i) => !i.checklistId)
//             ? [{ id: null, name: "Checklist", items: itemRows.filter((i) => !i.checklistId) }]
//             : []),
//         ],
//       },
//     });
//   }),
// );

// const updateDeliverableSchema = z.object({
//   title: z.string().min(2).max(200).optional(),
//   description: z.string().max(4000).optional(),
//   dueDate: z.coerce.date().nullable().optional(),
//   priority: z.enum(["low", "medium", "high", "urgent"]).optional(),
//   stageId: z.string().uuid().optional(),
//   clientId: z.string().uuid().nullable().optional(),
//   listId: z.string().uuid().nullable().optional(),
// });

// deliverablesRouter.patch(
//   "/:id",
//   asyncRoute(async (req, res) => {
//     const actor = requireActor(req);
//     const existing = await db.query.deliverables.findFirst({
//       where: and(eq(deliverables.id, req.params.id), eq(deliverables.workspaceId, actor.workspaceId)),
//       with: {
//         contentItem: { columns: { clientId: true } },
//         blockedBy: { with: { stage: true } },
//       },
//     });
//     if (!existing) throw new NotFoundError("Deliverable not found");

//     const clientId = existing.clientId ?? existing.contentItem?.clientId ?? null;
//     if (clientId === null) {
//       if (!canActOnStandalone(actor, "edit", existing.id)) {
//         return res.status(403).json({ error: "You cannot edit this deliverable" });
//       }
//     } else {
//       policy.assertCanEditDeliverable(actor, { clientId, deliverableId: existing.id });
//     }

//     const body = updateDeliverableSchema.parse(req.body);

//     // Changing the client: it must exist in this workspace and the actor must be allowed to use it.
//     if (body.clientId) {
//       await assertClientInWorkspace(body.clientId, actor.workspaceId);
//       if (!canUseClient(actor, body.clientId)) {
//         return res.status(403).json({ error: "You cannot assign this client to the deliverable" });
//       }
//     }

//     if (body.listId) {
//       const [list] = await db
//         .select({ id: lists.id })
//         .from(lists)
//         .where(and(eq(lists.id, body.listId), eq(lists.workspaceId, actor.workspaceId)))
//         .limit(1);
//       if (!list) throw new NotFoundError("List not found");
//     }

//     if (body.stageId && body.stageId !== existing.stageId) {
//       const [nextStage] = await db
//         .select()
//         .from(stages)
//         .where(and(eq(stages.id, body.stageId), eq(stages.workspaceId, actor.workspaceId)))
//         .limit(1);
//       if (!nextStage) throw new NotFoundError("Stage not found");

//       // Dependency enforcement (TSK-04): can't move out of backlog/blocked
//       // state while the predecessor this task depends on isn't done yet.
//       if (existing.blockedBy && existing.blockedBy.stage.stageType !== "done" && nextStage.stageType !== "backlog") {
//         return res.status(409).json({
//           error: `Blocked: "${existing.blockedById}" must reach Approved/Done before this can move to ${nextStage.label}`,
//         });
//       }
//     }

//     const updated = await db.transaction(async (tx) => {
//       const [result] = await tx.update(deliverables).set(body).where(eq(deliverables.id, existing.id)).returning();
//       // Moving a task to another List carries all of its subtasks (any depth) with it.
//       if (body.listId !== undefined && body.listId !== existing.listId) {
//         let frontier = [existing.id];
//         for (let depth = 0; frontier.length > 0 && depth < 20; depth++) {
//           const kids = await tx
//             .select({ id: deliverables.id })
//             .from(deliverables)
//             .where(inArray(deliverables.parentId, frontier));
//           frontier = kids.map((k) => k.id);
//           if (frontier.length > 0) {
//             await tx.update(deliverables).set({ listId: body.listId }).where(inArray(deliverables.id, frontier));
//           }
//         }
//       }
//       if (body.stageId && body.stageId !== existing.stageId) {
//         await tx.insert(stageTransitions).values({
//           deliverableId: existing.id,
//           fromStageId: existing.stageId,
//           toStageId: body.stageId,
//           changedById: actor.userId,
//         });
//       }
//       return result;
//     });

//     return res.json({ deliverable: updated });
//   }),
// );

// deliverablesRouter.delete(
//   "/:id",
//   asyncRoute(async (req, res) => {
//     const actor = requireActor(req);
//     const existing = await db.query.deliverables.findFirst({
//       where: and(eq(deliverables.id, req.params.id), eq(deliverables.workspaceId, actor.workspaceId)),
//       with: { contentItem: { columns: { clientId: true } } },
//     });
//     if (!existing) throw new NotFoundError("Deliverable not found");

//     const clientId = existing.clientId ?? existing.contentItem?.clientId ?? null;
//     if (clientId === null) {
//       if (!canActOnStandalone(actor, "edit", existing.id)) {
//         return res.status(403).json({ error: "You cannot delete this deliverable" });
//       }
//     } else {
//       policy.assertCanEditDeliverable(actor, { clientId, deliverableId: existing.id });
//     }

//     await db.delete(deliverables).where(eq(deliverables.id, existing.id));
//     return res.status(204).send();
//   }),
// );

// const assigneeSchema = z.object({ userId: z.string().uuid() });

// deliverablesRouter.post(
//   "/:id/assignees",
//   asyncRoute(async (req, res) => {
//     const actor = requireActor(req);
//     const result = await getDeliverableClientId(req.params.id);
//     if (!result.found) throw new NotFoundError("Deliverable not found");

//     if (result.clientId === null) {
//       if (!(actor.role === "admin" || actor.role === "manager" || actor.role === "team_member")) {
//         return res.status(403).json({ error: "You cannot assign people to this deliverable" });
//       }
//     } else if (!(actor.role === "admin" || (actor.role === "manager" && actor.assignedClientIds.has(result.clientId)))) {
//       return res.status(403).json({ error: "You cannot assign people to this deliverable" });
//     }

//     const body = assigneeSchema.parse(req.body);
//     await db
//       .insert(deliverableAssignees)
//       .values({ deliverableId: req.params.id, userId: body.userId })
//       .onConflictDoNothing({ target: [deliverableAssignees.deliverableId, deliverableAssignees.userId] });
//     return res.status(201).json({ ok: true });
//   }),
// );

// const checklistItemSchema = z.object({
//   label: z.string().min(1).max(300),
//   checklistId: z.string().uuid().optional(),
// });

// deliverablesRouter.post(
//   "/:id/checklist-items",
//   asyncRoute(async (req, res) => {
//     const actor = requireActor(req);
//     const result = await getDeliverableClientId(req.params.id);
//     if (!result.found) throw new NotFoundError("Deliverable not found");

//     if (result.clientId === null) {
//       if (!canActOnStandalone(actor, "edit", req.params.id)) {
//         return res.status(403).json({ error: "You cannot edit this deliverable" });
//       }
//     } else {
//       policy.assertCanEditDeliverable(actor, { clientId: result.clientId, deliverableId: req.params.id });
//     }

//     const body = checklistItemSchema.parse(req.body);
//     if (body.checklistId) {
//       const [owner] = await db
//         .select({ id: checklists.id })
//         .from(checklists)
//         .where(and(eq(checklists.id, body.checklistId), eq(checklists.deliverableId, req.params.id)))
//         .limit(1);
//       if (!owner) throw new NotFoundError("Checklist not found");
//     }
//     const existingCount = await db.select({ id: checklistItems.id }).from(checklistItems).where(eq(checklistItems.deliverableId, req.params.id));
//     const [item] = await db
//       .insert(checklistItems)
//       .values({ deliverableId: req.params.id, checklistId: body.checklistId, label: body.label, order: existingCount.length })
//       .returning();
//     return res.status(201).json({ checklistItem: item });
//   }),
// );

// deliverablesRouter.patch(
//   "/checklist-items/:itemId",
//   asyncRoute(async (req, res) => {
//     const actor = requireActor(req);
//     const [item] = await db.select().from(checklistItems).where(eq(checklistItems.id, req.params.itemId)).limit(1);
//     if (!item) throw new NotFoundError("Checklist item not found");

//     const result = await getDeliverableClientId(item.deliverableId);
//     if (!result.found) throw new NotFoundError("Deliverable not found");

//     if (result.clientId === null) {
//       if (!canActOnStandalone(actor, "edit", item.deliverableId)) {
//         return res.status(403).json({ error: "You cannot edit this deliverable" });
//       }
//     } else {
//       policy.assertCanEditDeliverable(actor, { clientId: result.clientId, deliverableId: item.deliverableId });
//     }

//     const body = z.object({ done: z.boolean() }).parse(req.body);
//     const [updated] = await db.update(checklistItems).set({ done: body.done }).where(eq(checklistItems.id, item.id)).returning();
//     return res.json({ checklistItem: updated });
//   }),
// );

// const commentSchema = z.object({
//   body: z.string().min(1).max(4000),
//   visibility: z.enum(["internal", "client_visible"]).default("internal"),
// });

// deliverablesRouter.post(
//   "/:id/comments",
//   asyncRoute(async (req, res) => {
//     const actor = requireActor(req);
//     const result = await getDeliverableClientId(req.params.id);
//     if (!result.found) throw new NotFoundError("Deliverable not found");

//     if (result.clientId === null) {
//       if (!canActOnStandalone(actor, "view", req.params.id)) {
//         return res.status(403).json({ error: "You do not have access to this deliverable" });
//       }
//     } else {
//       policy.assertCanViewDeliverable(actor, { clientId: result.clientId, deliverableId: req.params.id });
//     }

//     const body = commentSchema.parse(req.body);
//     if (actor.role === "client" && body.visibility === "internal") {
//       return res.status(403).json({ error: "Clients can only post client-visible comments" });
//     }

//     const [comment] = await db
//       .insert(comments)
//       .values({ deliverableId: req.params.id, authorId: actor.userId, body: body.body, visibility: body.visibility })
//       .returning();
//     return res.status(201).json({ comment });
//   }),
// );

// deliverablesRouter.get(
//   "/:id/comments",
//   asyncRoute(async (req, res) => {
//     const actor = requireActor(req);
//     const result = await getDeliverableClientId(req.params.id);
//     if (!result.found) throw new NotFoundError("Deliverable not found");

//     if (result.clientId === null) {
//       if (!canActOnStandalone(actor, "view", req.params.id)) {
//         return res.status(403).json({ error: "You do not have access to this deliverable" });
//       }
//     } else {
//       policy.assertCanViewDeliverable(actor, { clientId: result.clientId, deliverableId: req.params.id });
//     }

//     const conditions = [eq(comments.deliverableId, req.params.id)];
//     // Internal notes are never sent to a client, even if they somehow guess
//     // a comment id — filtered at the query level, not just hidden in the UI.
//     if (!policy.canViewInternalComments(actor)) {
//       conditions.push(eq(comments.visibility, "client_visible"));
//     }

//     const rows = await db.query.comments.findMany({
//       where: and(...conditions),
//       with: { author: { columns: { id: true, name: true, role: true } } },
//       orderBy: (t, { asc: ascOp }) => [ascOp(t.createdAt)],
//     });
//     return res.json({ comments: rows });
//   }),
// );

// /** Shared guard: the caller may edit this task (same rules as PATCH /:id). */
// async function assertCanEditById(actor: ActorScope, deliverableId: string) {
//   const result = await getDeliverableClientId(deliverableId);
//   if (!result.found) throw new NotFoundError("Deliverable not found");
//   if (result.clientId === null) {
//     if (!canActOnStandalone(actor, "edit", deliverableId)) throw new ForbiddenError("You cannot edit this deliverable");
//   } else {
//     policy.assertCanEditDeliverable(actor, { clientId: result.clientId, deliverableId });
//   }
// }

// // Named checklists (e.g. "QA") on a task or subtask
// deliverablesRouter.post(
//   "/:id/checklists",
//   asyncRoute(async (req, res) => {
//     const actor = requireActor(req);
//     await assertCanEditById(actor, req.params.id);
//     const body = z.object({ name: z.string().trim().min(1).max(120) }).parse(req.body);
//     const existing = await db.select({ id: checklists.id }).from(checklists).where(eq(checklists.deliverableId, req.params.id));
//     const [checklist] = await db
//       .insert(checklists)
//       .values({ deliverableId: req.params.id, name: body.name, order: existing.length })
//       .returning();
//     return res.status(201).json({ checklist });
//   }),
// );

// deliverablesRouter.delete(
//   "/checklists/:checklistId",
//   asyncRoute(async (req, res) => {
//     const actor = requireActor(req);
//     const [row] = await db.select().from(checklists).where(eq(checklists.id, req.params.checklistId)).limit(1);
//     if (!row) throw new NotFoundError("Checklist not found");
//     await assertCanEditById(actor, row.deliverableId);
//     await db.delete(checklists).where(eq(checklists.id, row.id));
//     return res.status(204).send();
//   }),
// );

// deliverablesRouter.delete(
//   "/checklist-items/:itemId",
//   asyncRoute(async (req, res) => {
//     const actor = requireActor(req);
//     const [item] = await db.select().from(checklistItems).where(eq(checklistItems.id, req.params.itemId)).limit(1);
//     if (!item) throw new NotFoundError("Checklist item not found");
//     await assertCanEditById(actor, item.deliverableId);
//     await db.delete(checklistItems).where(eq(checklistItems.id, item.id));
//     return res.status(204).send();
//   }),
// );



import { Router } from "express";
import { z } from "zod";
import { and, asc, eq, inArray, isNotNull, or } from "drizzle-orm";
import { db } from "../db/client";
import {
  deliverables,
  deliverableAssignees,
  contentItems,
  clients,
  stages,
  stageTransitions,
  checklistItems,
  checklists,
  lists,
  comments,
} from "../db/schema";
import { authenticate, requireActor } from "../middleware/auth";
import { asyncRoute, NotFoundError } from "../middleware/errorHandler";
import { policy, ForbiddenError } from "../policy/policy";
import type { ActorScope } from "../policy/actorScope";
import { notify } from "../lib/notify";

export const deliverablesRouter = Router();
deliverablesRouter.use(authenticate);

const NONE_ID = "00000000-0000-0000-0000-000000000000";

/**
 * Resolves the clientId a deliverable belongs to.
 * A direct deliverables.clientId wins; otherwise fall back to the client of
 * its linked content item (older tasks).
 * `found: false` means no such deliverable exists at all.
 * `found: true, clientId: null` means the deliverable exists but is
 * standalone (no client at all) — never conflate this with "not found".
 */
async function getDeliverableClientId(deliverableId: string): Promise<{ found: boolean; clientId: string | null }> {
  const row = await db.query.deliverables.findFirst({
    where: eq(deliverables.id, deliverableId),
    with: { contentItem: { columns: { clientId: true } } },
  });
  if (!row) return { found: false, clientId: null };
  return { found: true, clientId: row.clientId ?? row.contentItem?.clientId ?? null };
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

/** Can this actor attach work to this client? (admin: any; manager/team_member: assigned clients only) */
function canUseClient(actor: ActorScope, clientId: string): boolean {
  if (actor.role === "admin") return true;
  if (actor.role === "manager" || actor.role === "team_member") return actor.assignedClientIds.has(clientId);
  return false;
}

/** Throws NotFoundError unless the client exists in the actor's workspace. */
async function assertClientInWorkspace(clientId: string, workspaceId: string) {
  const [client] = await db
    .select({ id: clients.id })
    .from(clients)
    .where(and(eq(clients.id, clientId), eq(clients.workspaceId, workspaceId)))
    .limit(1);
  if (!client) throw new NotFoundError("Client not found");
}

/** Deliverable ids visible to this actor by client scope (staff/client roles). Null = "no extra filter (admin)". */
/** Deliverable ids visible to this actor by client scope (staff/client roles). Null = "no extra filter (admin)". */
/** Deliverable ids visible to this actor by client scope (staff/client roles). Null = "no extra filter (admin)". */
async function visibleDeliverableIdsByClient(actor: ActorScope): Promise<string[] | null> {
  if (actor.role === "admin") return null;

  if (actor.role === "team_member" || actor.role === "freelancer") {
    // Strict isolation: see only tasks personally assigned to you, never a
    // teammate's task on the same client.
    const rows = await db
      .select({ id: deliverableAssignees.deliverableId })
      .from(deliverableAssignees)
      .where(eq(deliverableAssignees.userId, actor.userId));
    return rows.map((r) => r.id);
  }

  let clientIds: string[];
  if (actor.role === "manager") {
    clientIds = Array.from(actor.assignedClientIds);
  } else if (actor.role === "client") {
    clientIds = actor.ownClientId ? [actor.ownClientId] : [];
  } else {
    return [];
  }
  if (clientIds.length === 0 && actor.role !== "manager") return [];

  const items = clientIds.length > 0
    ? await db.select({ id: contentItems.id }).from(contentItems).where(inArray(contentItems.clientId, clientIds))
    : [];
  const contentItemIds = items.map((i) => i.id);

  const rows = await db
    .select({ id: deliverables.id })
    .from(deliverables)
    .where(
      or(
        clientIds.length > 0 ? inArray(deliverables.clientId, clientIds) : undefined,
        contentItemIds.length > 0 ? inArray(deliverables.contentItemId, contentItemIds) : undefined,
        // Tasks filed in a List belong to the internal hierarchy: managers see them all.
        actor.role === "manager" ? isNotNull(deliverables.listId) : undefined,
      ),
    );
  return rows.map((r) => r.id);
}

deliverablesRouter.get(
  "/",
  asyncRoute(async (req, res) => {
    const actor = requireActor(req);
    const { stageId, assigneeId, clientId, listId, folderId, spaceId } = req.query as Record<string, string | undefined>;

    const conditions = [eq(deliverables.workspaceId, actor.workspaceId)];
    if (stageId) conditions.push(eq(deliverables.stageId, stageId));

    // Hierarchy filters: a List, every List in a Folder, or every List in a Space.
    if (listId) {
      conditions.push(eq(deliverables.listId, listId));
    } else if (folderId || spaceId) {
      const scope = await db
        .select({ id: lists.id })
        .from(lists)
        .where(and(eq(lists.workspaceId, actor.workspaceId), folderId ? eq(lists.folderId, folderId) : eq(lists.spaceId, spaceId!)));
      const ids = scope.map((l) => l.id);
      conditions.push(inArray(deliverables.listId, ids.length > 0 ? ids : [NONE_ID]));
    }

    if (clientId) {
      policy.assertCanViewClient(actor, clientId);
      const items = await db.select({ id: contentItems.id }).from(contentItems).where(eq(contentItems.clientId, clientId));
      const ids = items.map((i) => i.id);
      conditions.push(
        or(
          eq(deliverables.clientId, clientId),
          inArray(deliverables.contentItemId, ids.length > 0 ? ids : [NONE_ID]),
        )!,
      );
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
        client: { columns: { id: true, name: true } },
        list: { columns: { id: true, name: true, spaceId: true, folderId: true } },
      },
      orderBy: (t, { asc: ascOp }) => [ascOp(t.dueDate)],
    });

    return res.json({ deliverables: rows });
  }),
);

const createDeliverableSchema = z.object({
  contentItemId: z.string().uuid().optional(),
  clientId: z.string().uuid().optional(),
  title: z.string().min(2).max(200),
  description: z.string().max(4000).optional(),
  dueDate: z.coerce.date().optional(),
  priority: z.enum(["low", "medium", "high", "urgent"]).default("medium"),
  stageId: z.string().uuid(),
  ownerId: z.string().uuid(),
  assigneeIds: z.array(z.string().uuid()).default([]),
  parentId: z.string().uuid().optional(),
  blockedById: z.string().uuid().optional(),
  listId: z.string().uuid().optional(),
});

deliverablesRouter.post(
  "/",
  asyncRoute(async (req, res) => {
    const actor = requireActor(req);
    const body = createDeliverableSchema.parse(req.body);

    let resolvedClientId: string | undefined = body.clientId;
    let resolvedListId: string | undefined = body.listId;

    // Subtasks (to any depth): must hang off a task in this workspace and inherit its List / client.
    if (body.parentId) {
      const [parent] = await db
        .select()
        .from(deliverables)
        .where(and(eq(deliverables.id, body.parentId), eq(deliverables.workspaceId, actor.workspaceId)))
        .limit(1);
      if (!parent) throw new NotFoundError("Parent task not found");
      await assertCanEditById(actor, parent.id);
      resolvedListId = parent.listId ?? undefined;
      resolvedClientId = body.clientId ?? parent.clientId ?? undefined;
    }

    if (resolvedListId) {
      const [list] = await db
        .select({ id: lists.id })
        .from(lists)
        .where(and(eq(lists.id, resolvedListId), eq(lists.workspaceId, actor.workspaceId)))
        .limit(1);
      if (!list) throw new NotFoundError("List not found");
    }

    if (body.contentItemId) {
      const [contentItem] = await db
        .select()
        .from(contentItems)
        .where(and(eq(contentItems.id, body.contentItemId), eq(contentItems.workspaceId, actor.workspaceId)))
        .limit(1);
      if (!contentItem) throw new NotFoundError("Content item not found");
      if (!canUseClient(actor, contentItem.clientId)) {
        return res.status(403).json({ error: "You cannot add deliverables to this client's content" });
      }
      if (body.clientId && body.clientId !== contentItem.clientId) {
        return res.status(400).json({ error: "The selected client does not match the content item's client" });
      }
      resolvedClientId = contentItem.clientId;
    } else if (body.clientId) {
      await assertClientInWorkspace(body.clientId, actor.workspaceId);
      if (!canUseClient(actor, body.clientId)) {
        return res.status(403).json({ error: "You cannot add deliverables to this client" });
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
          clientId: resolvedClientId,
          listId: resolvedListId,
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

      // Team members only see tasks assigned to them, so a task they create must include them.
      const assigneeIds =
        actor.role === "team_member" && !body.assigneeIds.includes(actor.userId)
          ? [...body.assigneeIds, actor.userId]
          : body.assigneeIds;
      if (assigneeIds.length > 0) {
        await tx.insert(deliverableAssignees).values(assigneeIds.map((userId) => ({ deliverableId: created.id, userId })));
      }

      await tx.insert(stageTransitions).values({ deliverableId: created.id, toStageId: created.stageId, changedById: actor.userId });

      return created;
    });

    // Tell the people this task was assigned to (not the person who created it).
    await notify({
      workspaceId: actor.workspaceId,
      userIds: body.assigneeIds,
      excludeUserId: actor.userId,
      type: "task.assigned",
      title: `You were assigned: ${deliverable.title}`,
      body: deliverable.dueDate ? `Due ${new Date(deliverable.dueDate).toLocaleDateString()}` : undefined,
      link: `/deliverables/${deliverable.id}`,
    }).catch((err) => console.error("notify failed", err));

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
        client: { columns: { id: true, name: true } },
      },
    });
    if (!deliverable) throw new NotFoundError("Deliverable not found");

    const clientId = deliverable.clientId ?? deliverable.contentItem?.clientId ?? null;
    if (clientId === null) {
      if (!canActOnStandalone(actor, "view", deliverable.id)) {
        return res.status(403).json({ error: "You do not have access to this deliverable" });
      }
    } else {
      policy.assertCanViewDeliverable(actor, { clientId, deliverableId: deliverable.id });
    }

    const [checklistRows, itemRows, subtasks, list] = await Promise.all([
      db.select().from(checklists).where(eq(checklists.deliverableId, deliverable.id)).orderBy(asc(checklists.order), asc(checklists.createdAt)),
      db.select().from(checklistItems).where(eq(checklistItems.deliverableId, deliverable.id)).orderBy(asc(checklistItems.order)),
      db.query.deliverables.findMany({
        where: and(eq(deliverables.parentId, deliverable.id), eq(deliverables.workspaceId, actor.workspaceId)),
        with: {
          stage: true,
          assignees: { with: { user: { columns: { id: true, name: true } } } },
        },
        orderBy: (t, { asc: ascOp }) => [ascOp(t.createdAt)],
      }),
      deliverable.listId
        ? db.query.lists.findFirst({
            where: eq(lists.id, deliverable.listId),
            with: {
              space: { columns: { id: true, name: true } },
              folder: { columns: { id: true, name: true } },
            },
          })
        : Promise.resolve(null),
    ]);

    // Walk up parentId to build the breadcrumb (guarded against accidental cycles).
    const ancestors: { id: string; title: string }[] = [];
    let cursor = deliverable.parentId;
    for (let depth = 0; cursor && depth < 20; depth++) {
      const [parent] = await db
        .select({ id: deliverables.id, title: deliverables.title, parentId: deliverables.parentId })
        .from(deliverables)
        .where(and(eq(deliverables.id, cursor), eq(deliverables.workspaceId, actor.workspaceId)))
        .limit(1);
      if (!parent) break;
      ancestors.unshift({ id: parent.id, title: parent.title });
      cursor = parent.parentId;
    }

    return res.json({
      deliverable: {
        ...deliverable,
        list: list ?? null,
        subtasks,
        ancestors,
        // Named checklists, each with its items. Legacy ungrouped items are returned as one "Checklist".
        checklists: [
          ...checklistRows.map((c) => ({ id: c.id, name: c.name, items: itemRows.filter((i) => i.checklistId === c.id) })),
          ...(itemRows.some((i) => !i.checklistId)
            ? [{ id: null, name: "Checklist", items: itemRows.filter((i) => !i.checklistId) }]
            : []),
        ],
      },
    });
  }),
);

const updateDeliverableSchema = z.object({
  title: z.string().min(2).max(200).optional(),
  description: z.string().max(4000).optional(),
  dueDate: z.coerce.date().nullable().optional(),
  priority: z.enum(["low", "medium", "high", "urgent"]).optional(),
  stageId: z.string().uuid().optional(),
  clientId: z.string().uuid().nullable().optional(),
  listId: z.string().uuid().nullable().optional(),
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

    const clientId = existing.clientId ?? existing.contentItem?.clientId ?? null;
    if (clientId === null) {
      if (!canActOnStandalone(actor, "edit", existing.id)) {
        return res.status(403).json({ error: "You cannot edit this deliverable" });
      }
    } else {
      policy.assertCanEditDeliverable(actor, { clientId, deliverableId: existing.id });
    }

    const body = updateDeliverableSchema.parse(req.body);

    // Changing the client: it must exist in this workspace and the actor must be allowed to use it.
    if (body.clientId) {
      await assertClientInWorkspace(body.clientId, actor.workspaceId);
      if (!canUseClient(actor, body.clientId)) {
        return res.status(403).json({ error: "You cannot assign this client to the deliverable" });
      }
    }

    if (body.listId) {
      const [list] = await db
        .select({ id: lists.id })
        .from(lists)
        .where(and(eq(lists.id, body.listId), eq(lists.workspaceId, actor.workspaceId)))
        .limit(1);
      if (!list) throw new NotFoundError("List not found");
    }

    let stageLabel: string | undefined;
    if (body.stageId && body.stageId !== existing.stageId) {
      const [nextStage] = await db
        .select()
        .from(stages)
        .where(and(eq(stages.id, body.stageId), eq(stages.workspaceId, actor.workspaceId)))
        .limit(1);
      if (!nextStage) throw new NotFoundError("Stage not found");
      stageLabel = nextStage.label;

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
      // Moving a task to another List carries all of its subtasks (any depth) with it.
      if (body.listId !== undefined && body.listId !== existing.listId) {
        let frontier = [existing.id];
        for (let depth = 0; frontier.length > 0 && depth < 20; depth++) {
          const kids = await tx
            .select({ id: deliverables.id })
            .from(deliverables)
            .where(inArray(deliverables.parentId, frontier));
          frontier = kids.map((k) => k.id);
          if (frontier.length > 0) {
            await tx.update(deliverables).set({ listId: body.listId }).where(inArray(deliverables.id, frontier));
          }
        }
      }
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

    // Tell the task's owner and assignees about a stage move, due-date change or priority change
    // (never the person who made the change).
    const dateOnly = (d: Date | null | undefined) => (d ? d.toISOString().slice(0, 10) : null);
    const niceDate = (d: Date) =>
      d.toLocaleDateString("en-GB", { timeZone: "UTC", day: "numeric", month: "short", year: "numeric" });
    const stageChanged = !!stageLabel;
    const priorityChanged = body.priority !== undefined && body.priority !== existing.priority;
    const dueChanged = body.dueDate !== undefined && dateOnly(body.dueDate) !== dateOnly(existing.dueDate);

    if (stageChanged || priorityChanged || dueChanged) {
      const recipients = await taskWatcherIds(existing.id, existing.ownerId);
      const link = `/deliverables/${existing.id}`;

      if (stageChanged) {
        await notify({
          workspaceId: actor.workspaceId,
          userIds: recipients,
          excludeUserId: actor.userId,
          type: "task.stage_changed",
          title: `${updated.title} moved to ${stageLabel}`,
          link,
        }).catch((err) => console.error("notify failed", err));
      }

      const edits: string[] = [];
      if (dueChanged) edits.push(body.dueDate ? `due date is now ${niceDate(body.dueDate)}` : "due date was removed");
      if (priorityChanged) edits.push(`priority is now ${body.priority}`);
      if (edits.length > 0) {
        await notify({
          workspaceId: actor.workspaceId,
          userIds: recipients,
          excludeUserId: actor.userId,
          type: "task.updated",
          title: `Updated: ${updated.title}`,
          body: edits.join(", "),
          link,
        }).catch((err) => console.error("notify failed", err));
      }
    }

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

    const clientId = existing.clientId ?? existing.contentItem?.clientId ?? null;
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
    const inserted = await db
      .insert(deliverableAssignees)
      .values({ deliverableId: req.params.id, userId: body.userId })
      .onConflictDoNothing({ target: [deliverableAssignees.deliverableId, deliverableAssignees.userId] })
      .returning({ userId: deliverableAssignees.userId });

    // Only notify if they were newly added, not already on the task.
    if (inserted.length > 0) {
      const [task] = await db
        .select({ title: deliverables.title })
        .from(deliverables)
        .where(eq(deliverables.id, req.params.id))
        .limit(1);
      await notify({
        workspaceId: actor.workspaceId,
        userIds: [body.userId],
        excludeUserId: actor.userId,
        type: "task.assigned",
        title: `You were assigned: ${task?.title ?? "a task"}`,
        link: `/deliverables/${req.params.id}`,
      }).catch((err) => console.error("notify failed", err));
    }
    return res.status(201).json({ ok: true });
  }),
);

const checklistItemSchema = z.object({
  label: z.string().min(1).max(300),
  checklistId: z.string().uuid().optional(),
});

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
    if (body.checklistId) {
      const [owner] = await db
        .select({ id: checklists.id })
        .from(checklists)
        .where(and(eq(checklists.id, body.checklistId), eq(checklists.deliverableId, req.params.id)))
        .limit(1);
      if (!owner) throw new NotFoundError("Checklist not found");
    }
    const existingCount = await db.select({ id: checklistItems.id }).from(checklistItems).where(eq(checklistItems.deliverableId, req.params.id));
    const [item] = await db
      .insert(checklistItems)
      .values({ deliverableId: req.params.id, checklistId: body.checklistId, label: body.label, order: existingCount.length })
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

/** The task's owner plus everyone assigned to it: the people who should hear about changes. */
async function taskWatcherIds(deliverableId: string, ownerId: string): Promise<string[]> {
  const rows = await db
    .select({ userId: deliverableAssignees.userId })
    .from(deliverableAssignees)
    .where(eq(deliverableAssignees.deliverableId, deliverableId));
  return [ownerId, ...rows.map((r) => r.userId)];
}

/** Shared guard: the caller may edit this task (same rules as PATCH /:id). */
async function assertCanEditById(actor: ActorScope, deliverableId: string) {
  const result = await getDeliverableClientId(deliverableId);
  if (!result.found) throw new NotFoundError("Deliverable not found");
  if (result.clientId === null) {
    if (!canActOnStandalone(actor, "edit", deliverableId)) throw new ForbiddenError("You cannot edit this deliverable");
  } else {
    policy.assertCanEditDeliverable(actor, { clientId: result.clientId, deliverableId });
  }
}

// Named checklists (e.g. "QA") on a task or subtask
deliverablesRouter.post(
  "/:id/checklists",
  asyncRoute(async (req, res) => {
    const actor = requireActor(req);
    await assertCanEditById(actor, req.params.id);
    const body = z.object({ name: z.string().trim().min(1).max(120) }).parse(req.body);
    const existing = await db.select({ id: checklists.id }).from(checklists).where(eq(checklists.deliverableId, req.params.id));
    const [checklist] = await db
      .insert(checklists)
      .values({ deliverableId: req.params.id, name: body.name, order: existing.length })
      .returning();
    return res.status(201).json({ checklist });
  }),
);

deliverablesRouter.delete(
  "/checklists/:checklistId",
  asyncRoute(async (req, res) => {
    const actor = requireActor(req);
    const [row] = await db.select().from(checklists).where(eq(checklists.id, req.params.checklistId)).limit(1);
    if (!row) throw new NotFoundError("Checklist not found");
    await assertCanEditById(actor, row.deliverableId);
    await db.delete(checklists).where(eq(checklists.id, row.id));
    return res.status(204).send();
  }),
);

deliverablesRouter.delete(
  "/checklist-items/:itemId",
  asyncRoute(async (req, res) => {
    const actor = requireActor(req);
    const [item] = await db.select().from(checklistItems).where(eq(checklistItems.id, req.params.itemId)).limit(1);
    if (!item) throw new NotFoundError("Checklist item not found");
    await assertCanEditById(actor, item.deliverableId);
    await db.delete(checklistItems).where(eq(checklistItems.id, item.id));
    return res.status(204).send();
  }),
);
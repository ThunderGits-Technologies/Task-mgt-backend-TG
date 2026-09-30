import { Router } from "express";
import { z } from "zod";
import { and, asc, eq, inArray, isNotNull } from "drizzle-orm";
import { db } from "../db/client";
import { spaces, folders, lists, deliverables, deliverableAssignees } from "../db/schema";
import { authenticate, requireActor } from "../middleware/auth";
import { asyncRoute, NotFoundError } from "../middleware/errorHandler";
import { ForbiddenError } from "../policy/policy";
import type { ActorScope } from "../policy/actorScope";

/**
 * Workspace > Space > Folder (optional) > List. Tasks live in Lists
 * (deliverables.list_id). Structure is visible to internal staff only;
 * only admins and managers may create / rename / delete it.
 */

export const spacesRouter = Router();
export const foldersRouter = Router();
export const listsRouter = Router();
for (const r of [spacesRouter, foldersRouter, listsRouter]) r.use(authenticate);

const NONE_ID = "00000000-0000-0000-0000-000000000000";

function canViewStructure(actor: ActorScope) {
  return actor.role === "admin" || actor.role === "manager" || actor.role === "team_member";
}
function assertCanManage(actor: ActorScope) {
  if (!(actor.role === "admin" || actor.role === "manager")) {
    throw new ForbiddenError("Only admins and managers can change Spaces, Folders and Lists");
  }
}

const nameSchema = z.string().trim().min(1).max(120);

async function assertSpace(id: string, workspaceId: string) {
  const [row] = await db.select().from(spaces).where(and(eq(spaces.id, id), eq(spaces.workspaceId, workspaceId))).limit(1);
  if (!row) throw new NotFoundError("Space not found");
  return row;
}
async function assertFolder(id: string, workspaceId: string) {
  const [row] = await db.select().from(folders).where(and(eq(folders.id, id), eq(folders.workspaceId, workspaceId))).limit(1);
  if (!row) throw new NotFoundError("Folder not found");
  return row;
}
async function assertList(id: string, workspaceId: string) {
  const [row] = await db.select().from(lists).where(and(eq(lists.id, id), eq(lists.workspaceId, workspaceId))).limit(1);
  if (!row) throw new NotFoundError("List not found");
  return row;
}

/** Top-level task counts per list, respecting what this actor may see. */
async function taskCountsByList(actor: ActorScope): Promise<Map<string, number>> {
  const conditions = [
    eq(deliverables.workspaceId, actor.workspaceId),
    isNotNull(deliverables.listId),
  ];
  if (actor.role === "team_member") {
    const mine = await db
      .select({ id: deliverableAssignees.deliverableId })
      .from(deliverableAssignees)
      .where(eq(deliverableAssignees.userId, actor.userId));
    const ids = mine.map((m) => m.id);
    conditions.push(inArray(deliverables.id, ids.length > 0 ? ids : [NONE_ID]));
  }
  const rows = await db
    .select({ listId: deliverables.listId, parentId: deliverables.parentId })
    .from(deliverables)
    .where(and(...conditions));
  const map = new Map<string, number>();
  for (const r of rows) {
    if (!r.listId || r.parentId) continue; // subtasks are not counted as list tasks
    map.set(r.listId, (map.get(r.listId) ?? 0) + 1);
  }
  return map;
}

async function buildTree(actor: ActorScope) {
  const [spaceRows, folderRows, listRows, counts] = await Promise.all([
    db.select().from(spaces).where(and(eq(spaces.workspaceId, actor.workspaceId), eq(spaces.archived, false))).orderBy(asc(spaces.order), asc(spaces.createdAt)),
    db.select().from(folders).where(and(eq(folders.workspaceId, actor.workspaceId), eq(folders.archived, false))).orderBy(asc(folders.order), asc(folders.createdAt)),
    db.select().from(lists).where(and(eq(lists.workspaceId, actor.workspaceId), eq(lists.archived, false))).orderBy(asc(lists.order), asc(lists.createdAt)),
    taskCountsByList(actor),
  ]);

  const listNode = (l: (typeof listRows)[number]) => ({
    id: l.id,
    name: l.name,
    spaceId: l.spaceId,
    folderId: l.folderId,
    taskCount: counts.get(l.id) ?? 0,
  });

  return spaceRows.map((s) => ({
    id: s.id,
    name: s.name,
    color: s.color,
    folders: folderRows
      .filter((f) => f.spaceId === s.id)
      .map((f) => ({
        id: f.id,
        name: f.name,
        spaceId: f.spaceId,
        lists: listRows.filter((l) => l.folderId === f.id).map(listNode),
      })),
    // Lists that sit directly in the Space (no Folder)
    lists: listRows.filter((l) => l.spaceId === s.id && !l.folderId).map(listNode),
  }));
}

/* ───────────────────────── Spaces ───────────────────────── */

spacesRouter.get(
  "/tree",
  asyncRoute(async (req, res) => {
    const actor = requireActor(req);
    if (!canViewStructure(actor)) return res.json({ spaces: [] });
    return res.json({ spaces: await buildTree(actor) });
  }),
);

const spaceBody = z.object({ name: nameSchema, color: z.string().max(20).optional() });

spacesRouter.post(
  "/",
  asyncRoute(async (req, res) => {
    const actor = requireActor(req);
    assertCanManage(actor);
    const body = spaceBody.parse(req.body);
    const existing = await db.select({ id: spaces.id }).from(spaces).where(eq(spaces.workspaceId, actor.workspaceId));
    const [space] = await db
      .insert(spaces)
      .values({ workspaceId: actor.workspaceId, name: body.name, color: body.color, order: existing.length })
      .returning();
    return res.status(201).json({ space });
  }),
);

/**
 * One-click starter structure (only when the workspace has no Spaces yet):
 * Development > "Task Management App" > Sprint 1 / Bug Fixes, plus a Backlog
 * list directly in the Space; Marketing > Campaigns > Blog Content.
 */
spacesRouter.post(
  "/starter",
  asyncRoute(async (req, res) => {
    const actor = requireActor(req);
    assertCanManage(actor);
    const existing = await db.select({ id: spaces.id }).from(spaces).where(eq(spaces.workspaceId, actor.workspaceId)).limit(1);
    if (existing.length > 0) return res.status(409).json({ error: "This workspace already has Spaces" });

    await db.transaction(async (tx) => {
      const ws = actor.workspaceId;
      const [dev] = await tx.insert(spaces).values({ workspaceId: ws, name: "Development", color: "#2563eb", order: 0 }).returning();
      const [devFolder] = await tx.insert(folders).values({ workspaceId: ws, spaceId: dev.id, name: "Task Management App", order: 0 }).returning();
      await tx.insert(lists).values([
        { workspaceId: ws, spaceId: dev.id, folderId: devFolder.id, name: "Sprint 1", order: 0 },
        { workspaceId: ws, spaceId: dev.id, folderId: devFolder.id, name: "Bug Fixes", order: 1 },
        { workspaceId: ws, spaceId: dev.id, folderId: null, name: "Backlog", order: 0 },
      ]);
      const [mkt] = await tx.insert(spaces).values({ workspaceId: ws, name: "Marketing", color: "#d27740", order: 1 }).returning();
      const [mktFolder] = await tx.insert(folders).values({ workspaceId: ws, spaceId: mkt.id, name: "Campaigns", order: 0 }).returning();
      await tx.insert(lists).values({ workspaceId: ws, spaceId: mkt.id, folderId: mktFolder.id, name: "Blog Content", order: 0 });
    });
    return res.status(201).json({ spaces: await buildTree(actor) });
  }),
);

spacesRouter.patch(
  "/:id",
  asyncRoute(async (req, res) => {
    const actor = requireActor(req);
    assertCanManage(actor);
    const space = await assertSpace(req.params.id, actor.workspaceId);
    const body = spaceBody.partial().extend({ order: z.number().int().min(0).optional() }).parse(req.body);
    const [updated] = await db.update(spaces).set({ ...body, updatedAt: new Date() }).where(eq(spaces.id, space.id)).returning();
    return res.json({ space: updated });
  }),
);

/** Deleting a Space removes its Folders and Lists; tasks are kept (they fall back to "Everything"). */
spacesRouter.delete(
  "/:id",
  asyncRoute(async (req, res) => {
    const actor = requireActor(req);
    assertCanManage(actor);
    const space = await assertSpace(req.params.id, actor.workspaceId);
    await db.delete(spaces).where(eq(spaces.id, space.id));
    return res.status(204).send();
  }),
);

/* ───────────────────────── Folders ───────────────────────── */

foldersRouter.post(
  "/",
  asyncRoute(async (req, res) => {
    const actor = requireActor(req);
    assertCanManage(actor);
    const body = z.object({ spaceId: z.string().uuid(), name: nameSchema }).parse(req.body);
    await assertSpace(body.spaceId, actor.workspaceId);
    const siblings = await db.select({ id: folders.id }).from(folders).where(eq(folders.spaceId, body.spaceId));
    const [folder] = await db
      .insert(folders)
      .values({ workspaceId: actor.workspaceId, spaceId: body.spaceId, name: body.name, order: siblings.length })
      .returning();
    return res.status(201).json({ folder });
  }),
);

foldersRouter.patch(
  "/:id",
  asyncRoute(async (req, res) => {
    const actor = requireActor(req);
    assertCanManage(actor);
    const folder = await assertFolder(req.params.id, actor.workspaceId);
    const body = z.object({ name: nameSchema.optional(), order: z.number().int().min(0).optional() }).parse(req.body);
    const [updated] = await db.update(folders).set({ ...body, updatedAt: new Date() }).where(eq(folders.id, folder.id)).returning();
    return res.json({ folder: updated });
  }),
);

foldersRouter.delete(
  "/:id",
  asyncRoute(async (req, res) => {
    const actor = requireActor(req);
    assertCanManage(actor);
    const folder = await assertFolder(req.params.id, actor.workspaceId);
    await db.delete(folders).where(eq(folders.id, folder.id));
    return res.status(204).send();
  }),
);

/* ───────────────────────── Lists ───────────────────────── */

listsRouter.post(
  "/",
  asyncRoute(async (req, res) => {
    const actor = requireActor(req);
    assertCanManage(actor);
    const body = z
      .object({ spaceId: z.string().uuid(), folderId: z.string().uuid().nullable().optional(), name: nameSchema })
      .parse(req.body);
    await assertSpace(body.spaceId, actor.workspaceId);
    if (body.folderId) {
      const folder = await assertFolder(body.folderId, actor.workspaceId);
      if (folder.spaceId !== body.spaceId) return res.status(400).json({ error: "That Folder is not in this Space" });
    }
    const siblings = await db
      .select({ id: lists.id })
      .from(lists)
      .where(and(eq(lists.spaceId, body.spaceId), body.folderId ? eq(lists.folderId, body.folderId) : undefined));
    const [list] = await db
      .insert(lists)
      .values({
        workspaceId: actor.workspaceId,
        spaceId: body.spaceId,
        folderId: body.folderId ?? null,
        name: body.name,
        order: siblings.length,
      })
      .returning();
    return res.status(201).json({ list });
  }),
);

listsRouter.get(
  "/:id",
  asyncRoute(async (req, res) => {
    const actor = requireActor(req);
    if (!canViewStructure(actor)) throw new ForbiddenError("You do not have access to this List");
    const list = await assertList(req.params.id, actor.workspaceId);
    const [space] = await db.select({ id: spaces.id, name: spaces.name, color: spaces.color }).from(spaces).where(eq(spaces.id, list.spaceId)).limit(1);
    const folder = list.folderId
      ? (await db.select({ id: folders.id, name: folders.name }).from(folders).where(eq(folders.id, list.folderId)).limit(1))[0] ?? null
      : null;
    return res.json({ list: { ...list, space, folder } });
  }),
);

listsRouter.patch(
  "/:id",
  asyncRoute(async (req, res) => {
    const actor = requireActor(req);
    assertCanManage(actor);
    const list = await assertList(req.params.id, actor.workspaceId);
    const body = z
      .object({
        name: nameSchema.optional(),
        order: z.number().int().min(0).optional(),
        // Move the List into another Folder of the same Space, or out of any Folder (null)
        folderId: z.string().uuid().nullable().optional(),
      })
      .parse(req.body);
    if (body.folderId) {
      const folder = await assertFolder(body.folderId, actor.workspaceId);
      if (folder.spaceId !== list.spaceId) return res.status(400).json({ error: "That Folder is not in this List's Space" });
    }
    const [updated] = await db.update(lists).set({ ...body, updatedAt: new Date() }).where(eq(lists.id, list.id)).returning();
    return res.json({ list: updated });
  }),
);

/** Deleting a List keeps its tasks (list_id becomes null; they remain in "Everything"). */
listsRouter.delete(
  "/:id",
  asyncRoute(async (req, res) => {
    const actor = requireActor(req);
    assertCanManage(actor);
    const list = await assertList(req.params.id, actor.workspaceId);
    await db.delete(lists).where(eq(lists.id, list.id));
    return res.status(204).send();
  }),
);

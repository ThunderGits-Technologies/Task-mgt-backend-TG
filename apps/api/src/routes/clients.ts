import { Router } from "express";
import { z } from "zod";
import { and, eq, inArray } from "drizzle-orm";
import { db } from "../db/client";
import {deliverables, deliverableAssignees, clients, clientAssignments, users, auditLogs } from "../db/schema";
import { authenticate, requireActor } from "../middleware/auth";
import { asyncRoute, NotFoundError } from "../middleware/errorHandler";
import { policy } from "../policy/policy";

export const clientsRouter = Router();
clientsRouter.use(authenticate);

/** Lists only the clients this actor is actually allowed to see. */
clientsRouter.get(
  "/",
  asyncRoute(async (req, res) => {
    const actor = requireActor(req);

    if (actor.role === "freelancer") {
      return res.json({ clients: [] });
    }

    const conditions = [eq(clients.workspaceId, actor.workspaceId), eq(clients.archived, false)];

    if (actor.role === "manager") {
      const ids = Array.from(actor.assignedClientIds);
      conditions.push(inArray(clients.id, ids.length > 0 ? ids : ["00000000-0000-0000-0000-000000000000"]));
    } else if (actor.role === "team_member") {
      // Strict isolation: only clients whose tasks this person is personally
      // assigned to — for the client dropdown/filter, not full client access.
      const assignedRows = await db
        .select({ deliverableId: deliverableAssignees.deliverableId })
        .from(deliverableAssignees)
        .where(eq(deliverableAssignees.userId, actor.userId));
      const deliverableIds = assignedRows.map((r) => r.deliverableId);

      const idSet = new Set<string>();
      if (deliverableIds.length > 0) {
        const rows = await db
          .select({ clientId: deliverables.clientId })
          .from(deliverables)
          .where(inArray(deliverables.id, deliverableIds));
        for (const r of rows) if (r.clientId) idSet.add(r.clientId);
      }
      const ids = Array.from(idSet);
      conditions.push(inArray(clients.id, ids.length > 0 ? ids : ["00000000-0000-0000-0000-000000000000"]));
    } else if (actor.role === "client") {
      conditions.push(eq(clients.id, actor.ownClientId ?? "00000000-0000-0000-0000-000000000000"));
    }

    const rows = await db.select().from(clients).where(and(...conditions)).orderBy(clients.name);
    return res.json({ clients: rows });
  }),
);

const createClientSchema = z.object({
  name: z.string().min(2).max(160),
  brandColor: z.string().max(20).optional(),
  assignedUserIds: z.array(z.string().uuid()).default([]),
});

clientsRouter.post(
  "/",
  asyncRoute(async (req, res) => {
    const actor = requireActor(req);
    if (!(actor.role === "admin" || actor.role === "manager")) {
      return res.status(403).json({ error: "Only admins and managers can create clients" });
    }

    const body = createClientSchema.parse(req.body);

    const client = await db.transaction(async (tx) => {
      const [created] = await tx
        .insert(clients)
        .values({ workspaceId: actor.workspaceId, name: body.name, brandColor: body.brandColor })
        .returning();

      const assigneeIds = Array.from(new Set([...body.assignedUserIds, actor.userId]));
      await tx.insert(clientAssignments).values(assigneeIds.map((userId) => ({ clientId: created.id, userId })));

      await tx.insert(auditLogs).values({
        workspaceId: actor.workspaceId,
        actorId: actor.userId,
        action: "client.created",
        targetType: "client",
        targetId: created.id,
      });

      return created;
    });

    return res.status(201).json({ client });
  }),
);
clientsRouter.delete(
  "/:clientId",
  asyncRoute(async (req, res) => {
    const actor = requireActor(req);
    if (actor.role !== "admin") {
      return res.status(403).json({ error: "Only admins can delete clients" });
    }

    const [client] = await db
      .select()
      .from(clients)
      .where(and(eq(clients.id, req.params.clientId), eq(clients.workspaceId, actor.workspaceId)))
      .limit(1);
    if (!client) throw new NotFoundError("Client not found");

    await db.transaction(async (tx) => {
      await tx.update(clients).set({ archived: true }).where(eq(clients.id, client.id));
      await tx.insert(auditLogs).values({
        workspaceId: actor.workspaceId,
        actorId: actor.userId,
        action: "client.archived",
        targetType: "client",
        targetId: client.id,
      });
    });

    return res.json({ ok: true });
  }),
);
clientsRouter.get(
  "/:clientId",
  asyncRoute(async (req, res) => {
    const actor = requireActor(req);
    const [client] = await db
      .select()
      .from(clients)
      .where(and(eq(clients.id, req.params.clientId), eq(clients.workspaceId, actor.workspaceId)))
      .limit(1);
    if (!client) throw new NotFoundError("Client not found");
    policy.assertCanViewClient(actor, client.id);
    return res.json({ client });
  }),
);

const assignSchema = z.object({ userId: z.string().uuid() });

clientsRouter.post(
  "/:clientId/assignments",
  asyncRoute(async (req, res) => {
    const actor = requireActor(req);
    const [client] = await db
      .select()
      .from(clients)
      .where(and(eq(clients.id, req.params.clientId), eq(clients.workspaceId, actor.workspaceId)))
      .limit(1);
    if (!client) throw new NotFoundError("Client not found");
    if (!(actor.role === "admin" || (actor.role === "manager" && actor.assignedClientIds.has(client.id)))) {
      return res.status(403).json({ error: "You cannot manage assignments for this client" });
    }

    const body = assignSchema.parse(req.body);
    const [targetUser] = await db
      .select()
      .from(users)
      .where(and(eq(users.id, body.userId), eq(users.workspaceId, actor.workspaceId)))
      .limit(1);
    if (!targetUser) throw new NotFoundError("User not found");
    if (targetUser.role === "client") {
      return res.status(400).json({ error: "Use the invite flow to link a client contact" });
    }

    await db
      .insert(clientAssignments)
      .values({ clientId: client.id, userId: targetUser.id })
      .onConflictDoNothing({ target: [clientAssignments.clientId, clientAssignments.userId] });

    return res.status(201).json({ ok: true });
  }),
);

import { randomBytes } from "node:crypto";
import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { and, eq, inArray, ne } from "drizzle-orm";
import { ROLES } from "@agency/shared";
import { db } from "../db/client";
import { users, invitations, auditLogs, clientContacts, clientAssignments } from "../db/schema";
import { hashPassword } from "../lib/auth";
import { authenticate, requireActor } from "../middleware/auth";
import { asyncRoute, NotFoundError } from "../middleware/errorHandler";
import { policy } from "../policy/policy";

export const usersRouter = Router();
usersRouter.use(authenticate);

usersRouter.get(
  "/",
  asyncRoute(async (req, res) => {
    const actor = requireActor(req);
    policy.canManageWorkspace(actor); // listing everyone is an admin/settings action

    const rows = await db
      .select({ id: users.id, name: users.name, email: users.email, role: users.role, status: users.status, createdAt: users.createdAt })
      .from(users)
      .where(eq(users.workspaceId, actor.workspaceId))
      .orderBy(users.createdAt);
    return res.json({ users: rows });
  }),
);

/**
 * A lighter list than GET /: the staff a manager/team member could plausibly
 * assign a task to or filter a board by — not gated behind admin, since
 * picking an assignee is an everyday action, not a settings one. It never
 * includes client contacts.
 */
usersRouter.get(
  "/assignable",
  asyncRoute(async (req, res) => {
    const actor = requireActor(req);

    if (actor.role === "admin") {
      const rows = await db
        .select({ id: users.id, name: users.name, role: users.role })
        .from(users)
        .where(and(eq(users.workspaceId, actor.workspaceId), ne(users.role, "client"), eq(users.status, "active")))
        .orderBy(users.name);
      return res.json({ users: rows });
    }

    if (actor.role === "manager" || actor.role === "team_member") {
      const clientIds = Array.from(actor.assignedClientIds);
      if (clientIds.length === 0) return res.json({ users: [] });
      const rows = await db
        .selectDistinct({ id: users.id, name: users.name, role: users.role })
        .from(clientAssignments)
        .innerJoin(users, eq(users.id, clientAssignments.userId))
        .where(and(inArray(clientAssignments.clientId, clientIds), eq(users.status, "active")))
        .orderBy(users.name);
      return res.json({ users: rows });
    }

    // Freelancers and clients don't assign work to others.
    return res.json({ users: [] });
  }),
);

const inviteSchema = z.object({
  email: z.string().email(),
  name: z.string().min(2).max(120),
  role: z.enum(ROLES),
  clientIds: z.array(z.string().uuid()).default([]),
});

/**
 * Creates a pending invitation. In this local/dev build there is no email
 * service wired up, so the accept link is returned directly in the response
 * — swap this for a real email send once a transactional-email provider is
 * connected (see the plan's Notifications module, NTF-04).
 */
usersRouter.post(
  "/invite",
  asyncRoute(async (req, res) => {
    const actor = requireActor(req);
    policy.canInviteUser(actor);

    const body = inviteSchema.parse(req.body);

    if (body.role === "client" && body.clientIds.length !== 1) {
      return res.status(400).json({ error: "A client invite must reference exactly one client" });
    }
    for (const clientId of body.clientIds) {
      policy.assertCanViewClient(actor, clientId);
    }

    const [alreadyExists] = await db.select().from(users).where(eq(users.email, body.email)).limit(1);
    if (alreadyExists) {
      return res.status(409).json({ error: "A user with this email already exists" });
    }

    const token = randomBytes(24).toString("hex");
    const [invitation] = await db
      .insert(invitations)
      .values({
        workspaceId: actor.workspaceId,
        email: body.email,
        name: body.name,
        role: body.role,
        clientIds: body.clientIds,
        token,
        invitedById: actor.userId,
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      })
      .returning();

    await db.insert(auditLogs).values({
      workspaceId: actor.workspaceId,
      actorId: actor.userId,
      action: "user.invited",
      targetType: "invitation",
      targetId: invitation.id,
      metadata: { email: body.email, role: body.role },
    });

    return res.status(201).json({
      invitation: { id: invitation.id, email: invitation.email, role: invitation.role, expiresAt: invitation.expiresAt },
      acceptUrl: `/accept-invite?token=${token}`,
    });
  }),
);


const directAddSchema = z.object({
  email: z.string().email(),
  name: z.string().min(2).max(120),
  role: z.enum(ROLES),
  clientIds: z.array(z.string().uuid()).default([]),
});

/**
 * Creates a fully active user immediately, with no invitation/accept step.
 * A random temporary password is generated and returned once in the
 * response — it is never stored in plaintext or logged. The admin is
 * responsible for passing it along to the person out of band.
 */
usersRouter.post(
  "/direct",
  asyncRoute(async (req, res) => {
    const actor = requireActor(req);
    policy.canInviteUser(actor); // same permission as inviting

    const body = directAddSchema.parse(req.body);

    if (body.role === "client" && body.clientIds.length !== 1) {
      return res.status(400).json({ error: "A client account must reference exactly one client" });
    }
    for (const clientId of body.clientIds) {
      policy.assertCanViewClient(actor, clientId);
    }

    const [alreadyExists] = await db.select().from(users).where(eq(users.email, body.email)).limit(1);
    if (alreadyExists) {
      return res.status(409).json({ error: "A user with this email already exists" });
    }

    const temporaryPassword = randomBytes(9).toString("base64url"); // ~12 char random string
    const passwordHash = await hashPassword(temporaryPassword);

    const user = await db.transaction(async (tx) => {
      const [created] = await tx
        .insert(users)
        .values({
          workspaceId: actor.workspaceId,
          email: body.email,
          name: body.name,
          role: body.role,
          passwordHash,
          status: "active",
        })
        .returning();

      if (body.role === "client") {
        await tx.insert(clientContacts).values({ clientId: body.clientIds[0], userId: created.id });
      } else if (body.clientIds.length > 0) {
        await tx.insert(clientAssignments).values(body.clientIds.map((clientId) => ({ clientId, userId: created.id })));
      }

      return created;
    });

    await db.insert(auditLogs).values({
      workspaceId: actor.workspaceId,
      actorId: actor.userId,
      action: "user.created_directly",
      targetType: "user",
      targetId: user.id,
      metadata: { email: body.email, role: body.role },
    });

    return res.status(201).json({
      user: { id: user.id, email: user.email, name: user.name, role: user.role, status: user.status },
      temporaryPassword,
    });
  }),
);

usersRouter.delete(
  "/:userId",
  asyncRoute(async (req, res) => {
    const actor = requireActor(req);
    policy.canManageWorkspace(actor);

    const [user] = await db
      .select()
      .from(users)
      .where(and(eq(users.id, req.params.userId), eq(users.workspaceId, actor.workspaceId)))
      .limit(1);
    if (!user) throw new NotFoundError("User not found");
    if (user.id === actor.userId) {
      return res.status(400).json({ error: "You cannot remove your own account" });
    }

    await db.update(users).set({ status: "suspended" }).where(eq(users.id, user.id));
    await db.insert(auditLogs).values({
      workspaceId: actor.workspaceId,
      actorId: actor.userId,
      action: "user.suspended",
      targetType: "user",
      targetId: user.id,
    });
    return res.status(204).send();
  }),
);

const acceptInviteSchema = z.object({
  token: z.string().min(10),
  password: z.string().min(8).max(200),
});

/**
 * Public-ish route (no auth needed — the token IS the credential), but kept
 * on the users router since it finalizes a User record. Mounted separately
 * in app.ts before the `authenticate` middleware applies.
 */
export async function acceptInviteHandler(req: Request, res: Response) {
  const body = acceptInviteSchema.parse(req.body);

  const [invitation] = await db.select().from(invitations).where(eq(invitations.token, body.token)).limit(1);
  if (!invitation || invitation.acceptedAt || invitation.expiresAt < new Date()) {
    return res.status(400).json({ error: "This invitation is invalid or has expired" });
  }

  const passwordHash = await hashPassword(body.password);

  const user = await db.transaction(async (tx) => {
    const [created] = await tx
      .insert(users)
      .values({
        workspaceId: invitation.workspaceId,
        email: invitation.email,
        name: invitation.name,
        role: invitation.role,
        passwordHash,
        status: "active",
      })
      .returning();

    if (invitation.role === "client") {
      await tx.insert(clientContacts).values({ clientId: invitation.clientIds[0], userId: created.id });
    } else if (invitation.clientIds.length > 0) {
      await tx.insert(clientAssignments).values(invitation.clientIds.map((clientId) => ({ clientId, userId: created.id })));
    }

    await tx.update(invitations).set({ acceptedAt: new Date() }).where(eq(invitations.id, invitation.id));
    return created;
  });

  return res.status(201).json({ user: { id: user.id, email: user.email, role: user.role } });
}

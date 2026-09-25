import { Router } from "express";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { DEFAULT_STAGES } from "@agency/shared";
import { db } from "../db/client";
import { workspaces, users, stages, auditLogs } from "../db/schema";
import { hashPassword, verifyPassword, signAuthToken, AUTH_COOKIE_NAME } from "../lib/auth";
import { asyncRoute } from "../middleware/errorHandler";
import { authenticate, requireActor } from "../middleware/auth";

export const authRouter = Router();

const isProd = process.env.NODE_ENV === "production";

const cookieOptions = {
  httpOnly: true,
  sameSite: isProd ? ("none" as const) : ("lax" as const),
  secure: isProd,
  maxAge: 7 * 24 * 60 * 60 * 1000,
};

const registerAgencySchema = z.object({
  workspaceName: z.string().min(2).max(120),
  adminName: z.string().min(2).max(120),
  email: z.string().email(),
  password: z.string().min(8).max(200),
});

/**
 * Bootstraps a brand-new agency: creates the workspace, the default stage
 * set (Brief -> Production -> Internal Review -> Client Review -> Approved),
 * and the first admin user. There is deliberately no "list workspaces"
 * endpoint here — this route is for one-time setup, not ongoing sign-up.
 */
authRouter.post(
  "/register-agency",
  asyncRoute(async (req, res) => {
    const body = registerAgencySchema.parse(req.body);

    const [existing] = await db.select().from(users).where(eq(users.email, body.email)).limit(1);
    if (existing) {
      return res.status(409).json({ error: "An account with this email already exists" });
    }

    const passwordHash = await hashPassword(body.password);

    const result = await db.transaction(async (tx) => {
      const [workspace] = await tx.insert(workspaces).values({ name: body.workspaceName }).returning();

      await tx.insert(stages).values(
        DEFAULT_STAGES.map((s) => ({
          workspaceId: workspace.id,
          key: s.key,
          label: s.label,
          stageType: s.stageType,
          order: s.order,
        })),
      );

      const [admin] = await tx
        .insert(users)
        .values({ workspaceId: workspace.id, email: body.email, passwordHash, name: body.adminName, role: "admin" })
        .returning();

      await tx.insert(auditLogs).values({
        workspaceId: workspace.id,
        actorId: admin.id,
        action: "workspace.created",
        targetType: "workspace",
        targetId: workspace.id,
      });

      return { workspace, admin };
    });

    const token = signAuthToken({ userId: result.admin.id, workspaceId: result.workspace.id, role: result.admin.role });

    res.cookie(AUTH_COOKIE_NAME, token, cookieOptions);
    return res.status(201).json({
      token,
      workspace: { id: result.workspace.id, name: result.workspace.name },
      user: { id: result.admin.id, name: result.admin.name, email: result.admin.email, role: result.admin.role },
    });
  }),
);

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

authRouter.post(
  "/login",
  asyncRoute(async (req, res) => {
    const body = loginSchema.parse(req.body);
    const [user] = await db.select().from(users).where(eq(users.email, body.email)).limit(1);

    if (!user || user.status !== "active") {
      return res.status(401).json({ error: "Invalid email or password" });
    }

    const valid = await verifyPassword(body.password, user.passwordHash);
    if (!valid) {
      return res.status(401).json({ error: "Invalid email or password" });
    }

    const token = signAuthToken({ userId: user.id, workspaceId: user.workspaceId, role: user.role });
    res.cookie(AUTH_COOKIE_NAME, token, cookieOptions);
    return res.json({
      token,
      user: { id: user.id, name: user.name, email: user.email, role: user.role },
    });
  }),
);

authRouter.post("/logout", (_req, res) => {
  res.clearCookie(AUTH_COOKIE_NAME);
  return res.status(204).send();
});

authRouter.get(
  "/me",
  authenticate,
  asyncRoute(async (req, res) => {
    const actor = requireActor(req);
    const [user] = await db.select().from(users).where(eq(users.id, actor.userId)).limit(1);
    if (!user) return res.status(404).json({ error: "User not found" });
    return res.json({
      user: { id: user.id, name: user.name, email: user.email, role: user.role },
      workspaceId: actor.workspaceId,
    });
  }),
);

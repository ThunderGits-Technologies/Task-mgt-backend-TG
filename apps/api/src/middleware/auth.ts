import type { NextFunction, Request, Response } from "express";
import { eq } from "drizzle-orm";
import { AUTH_COOKIE_NAME, verifyAuthToken } from "../lib/auth";
import { loadActorScope, type ActorScope } from "../policy/actorScope";
import { db } from "../db/client";
import { users } from "../db/schema";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      actor?: ActorScope;
    }
  }
}

/**
 * Reads the session cookie (falls back to a Bearer header for API testing),
 * verifies the JWT, re-checks the user is still active (an admin may have
 * suspended them since the token was issued), and attaches the loaded
 * ActorScope to the request. Every route below this in the chain can then
 * trust req.actor without re-deriving it.
 */
export async function authenticate(req: Request, res: Response, next: NextFunction) {
  try {
    const cookieToken = req.cookies?.[AUTH_COOKIE_NAME];
    const headerToken = req.headers.authorization?.startsWith("Bearer ")
      ? req.headers.authorization.slice("Bearer ".length)
      : undefined;
    const token = cookieToken ?? headerToken;

    if (!token) {
      return res.status(401).json({ error: "Not authenticated" });
    }

    const payload = verifyAuthToken(token);

    const [user] = await db.select().from(users).where(eq(users.id, payload.userId)).limit(1);
    if (!user || user.status !== "active") {
      return res.status(401).json({ error: "Session is no longer valid" });
    }

    req.actor = await loadActorScope(user.id, user.workspaceId, user.role);
    return next();
  } catch {
    return res.status(401).json({ error: "Invalid or expired session" });
  }
}

export function requireActor(req: Request): ActorScope {
  if (!req.actor) {
    // Should never happen if `authenticate` ran first — fail loudly rather
    // than silently treating an unauthenticated request as low-privilege.
    throw new Error("requireActor() called without authenticate() middleware");
  }
  return req.actor;
}

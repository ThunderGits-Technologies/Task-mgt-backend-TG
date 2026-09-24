import { Router } from "express";
import { z } from "zod";
import { and, eq, gte, inArray, lte } from "drizzle-orm";
import { db } from "../db/client";
import { contentItems } from "../db/schema";
import { authenticate, requireActor } from "../middleware/auth";
import { asyncRoute, NotFoundError } from "../middleware/errorHandler";
import { policy } from "../policy/policy";

export const contentItemsRouter = Router();
contentItemsRouter.use(authenticate);

const CHANNELS = ["instagram", "facebook", "linkedin", "x", "youtube", "blog", "email", "ads", "other"] as const;
const NONE_ID = "00000000-0000-0000-0000-000000000000";

/**
 * The monthly/combined calendar feed. `clientId` narrows to one client's
 * calendar; omitted, it returns the combined multi-client view (CAL-01),
 * already filtered down to clients this actor may see.
 */
contentItemsRouter.get(
  "/",
  asyncRoute(async (req, res) => {
    const actor = requireActor(req);
    const { clientId, from, to, channel, status } = req.query as Record<string, string | undefined>;

    if (clientId) {
      policy.assertCanViewClient(actor, clientId);
    }

    const conditions = [eq(contentItems.workspaceId, actor.workspaceId)];

    if (clientId) {
      conditions.push(eq(contentItems.clientId, clientId));
    } else if (actor.role === "admin") {
      // no extra filter
    } else if (actor.role === "manager" || actor.role === "team_member") {
      const ids = Array.from(actor.assignedClientIds);
      conditions.push(inArray(contentItems.clientId, ids.length > 0 ? ids : [NONE_ID]));
    } else if (actor.role === "client") {
      conditions.push(eq(contentItems.clientId, actor.ownClientId ?? NONE_ID));
    } else {
      // freelancers browse via their deliverables, not the calendar
      return res.json({ contentItems: [] });
    }

    if (channel) conditions.push(eq(contentItems.channel, channel as (typeof CHANNELS)[number]));
    if (status) conditions.push(eq(contentItems.status, status as any));
    if (from) conditions.push(gte(contentItems.publishDate, new Date(from)));
    if (to) conditions.push(lte(contentItems.publishDate, new Date(to)));

    const items = await db.query.contentItems.findMany({
      where: and(...conditions),
      with: {
        client: { columns: { id: true, name: true, brandColor: true } },
        deliverables: { columns: { id: true, title: true, stageId: true, dueDate: true } },
      },
      orderBy: (t, { asc }) => [asc(t.publishDate)],
    });

    return res.json({ contentItems: items });
  }),
);

const createContentItemSchema = z.object({
  clientId: z.string().uuid(),
  title: z.string().min(2).max(200),
  channel: z.enum(CHANNELS),
  format: z.string().min(1).max(60),
  publishDate: z.coerce.date(),
});

contentItemsRouter.post(
  "/",
  asyncRoute(async (req, res) => {
    const actor = requireActor(req);
    const body = createContentItemSchema.parse(req.body);
    policy.assertCanCreateContentItem(actor, body.clientId);

    const [item] = await db
      .insert(contentItems)
      .values({
        workspaceId: actor.workspaceId,
        clientId: body.clientId,
        title: body.title,
        channel: body.channel,
        format: body.format,
        publishDate: body.publishDate,
        createdById: actor.userId,
      })
      .returning();

    return res.status(201).json({ contentItem: item });
  }),
);

contentItemsRouter.get(
  "/:id",
  asyncRoute(async (req, res) => {
    const actor = requireActor(req);
    const item = await db.query.contentItems.findFirst({
      where: and(eq(contentItems.id, req.params.id), eq(contentItems.workspaceId, actor.workspaceId)),
      with: {
        deliverables: {
          with: { stage: true, assignees: { with: { user: true } } },
        },
      },
    });
    if (!item) throw new NotFoundError("Content item not found");
    policy.assertCanViewClient(actor, item.clientId);
    return res.json({ contentItem: item });
  }),
);

const updateContentItemSchema = z.object({
  title: z.string().min(2).max(200).optional(),
  format: z.string().min(1).max(60).optional(),
  publishDate: z.coerce.date().optional(),
  status: z.enum(["planned", "in_production", "ready", "scheduled", "published"]).optional(),
});

contentItemsRouter.patch(
  "/:id",
  asyncRoute(async (req, res) => {
    const actor = requireActor(req);
    const [item] = await db
      .select()
      .from(contentItems)
      .where(and(eq(contentItems.id, req.params.id), eq(contentItems.workspaceId, actor.workspaceId)))
      .limit(1);
    if (!item) throw new NotFoundError("Content item not found");
    if (!(actor.role === "admin" || ((actor.role === "manager" || actor.role === "team_member") && actor.assignedClientIds.has(item.clientId)))) {
      return res.status(403).json({ error: "You cannot edit this content item" });
    }

    const body = updateContentItemSchema.parse(req.body);
    const [updated] = await db.update(contentItems).set(body).where(eq(contentItems.id, item.id)).returning();
    return res.json({ contentItem: updated });
  }),
);

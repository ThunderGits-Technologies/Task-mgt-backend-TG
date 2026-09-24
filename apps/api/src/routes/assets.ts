import { Router } from "express";
import { z } from "zod";
import { and, desc, eq } from "drizzle-orm";
import { db } from "../db/client";
import { assets, assetVersions, assetFeedback, deliverables } from "../db/schema";
import { authenticate, requireActor } from "../middleware/auth";
import { asyncRoute, NotFoundError } from "../middleware/errorHandler";
import { policy, ForbiddenError } from "../policy/policy";
import { upload, saveFileBuffer, resolveStoragePath } from "../lib/storage";
import { notify } from "../lib/notify";

export const assetsRouter = Router();
assetsRouter.use(authenticate);

/** Resolves a deliverable's clientId (via its content item) plus the people who should hear about activity on it. */
async function loadDeliverableContext(deliverableId: string) {
  const deliverable = await db.query.deliverables.findFirst({
    where: eq(deliverables.id, deliverableId),
    with: {
      contentItem: { columns: { clientId: true } },
      assignees: { columns: { userId: true } },
    },
  });
  if (!deliverable) return null;
  const clientId = deliverable.contentItem?.clientId ?? null;
  const watcherIds = [deliverable.ownerId, ...deliverable.assignees.map((a) => a.userId)];
  return { deliverable, clientId, watcherIds };
}

async function loadAssetWithClient(assetId: string) {
  const [asset] = await db.select().from(assets).where(eq(assets.id, assetId)).limit(1);
  return asset ?? null;
}

/** Everyone who has left feedback on this asset — used so a new version notifies past reviewers too. */
async function pastFeedbackAuthors(assetId: string): Promise<string[]> {
  const rows = await db.selectDistinct({ authorId: assetFeedback.authorId }).from(assetFeedback).where(eq(assetFeedback.assetId, assetId));
  return rows.map((r) => r.authorId);
}

const NAME_MAX = 200;

/** Upload the first version of an asset (e.g. a poster) against a deliverable. */
assetsRouter.post(
  "/deliverables/:deliverableId/assets",
  upload.single("file"),
  asyncRoute(async (req, res) => {
    const actor = requireActor(req);
    const ctx = await loadDeliverableContext(req.params.deliverableId);
    if (!ctx) throw new NotFoundError("Deliverable not found");
    if (!ctx.clientId) return res.status(400).json({ error: "This deliverable isn't linked to a client's content yet" });

    policy.assertCanEditDeliverable(actor, { clientId: ctx.clientId, deliverableId: ctx.deliverable.id });

    if (!req.file) return res.status(400).json({ error: "No file was uploaded (field name must be 'file')" });

    const name = (req.body.name as string | undefined)?.slice(0, NAME_MAX) || req.file.originalname;

    const result = await db.transaction(async (tx) => {
      const [asset] = await tx
        .insert(assets)
        .values({
          workspaceId: actor.workspaceId,
          clientId: ctx.clientId!,
          deliverableId: ctx.deliverable.id,
          name,
          status: "in_review",
        })
        .returning();

      const storageKey = saveFileBuffer({
        workspaceId: actor.workspaceId,
        assetId: asset.id,
        versionNumber: 1,
        originalFilename: req.file!.originalname,
        buffer: req.file!.buffer,
      });

      const [version] = await tx
        .insert(assetVersions)
        .values({
          assetId: asset.id,
          versionNumber: 1,
          storageKey,
          originalFilename: req.file!.originalname,
          mimeType: req.file!.mimetype,
          sizeBytes: req.file!.size,
          uploadedById: actor.userId,
        })
        .returning();

      return { asset, version };
    });

    await notify({
      workspaceId: actor.workspaceId,
      userIds: ctx.watcherIds,
      excludeUserId: actor.userId,
      type: "asset.uploaded",
      title: `${name} was uploaded for review`,
      body: `On "${ctx.deliverable.title}"`,
      link: `/deliverables/${ctx.deliverable.id}`,
    });

    return res.status(201).json({ asset: { ...result.asset, versions: [result.version] } });
  }),
);

/** List every asset attached to a deliverable, versions and feedback included. */
assetsRouter.get(
  "/deliverables/:deliverableId/assets",
  asyncRoute(async (req, res) => {
    const actor = requireActor(req);
    const ctx = await loadDeliverableContext(req.params.deliverableId);
    if (!ctx) throw new NotFoundError("Deliverable not found");
    policy.assertCanViewDeliverable(actor, { clientId: ctx.clientId ?? "", deliverableId: ctx.deliverable.id });

    const rows = await db.query.assets.findMany({
      where: eq(assets.deliverableId, ctx.deliverable.id),
      with: {
        versions: { orderBy: (t, { asc }) => [asc(t.versionNumber)], with: { uploadedBy: { columns: { id: true, name: true } } } },
        feedback: { orderBy: (t, { asc }) => [asc(t.createdAt)], with: { author: { columns: { id: true, name: true, role: true } } } },
      },
      orderBy: (t, { desc: descOp }) => [descOp(t.createdAt)],
    });

    return res.json({ assets: rows });
  }),
);

/** Upload a new version of an existing asset (re-upload after feedback). */
assetsRouter.post(
  "/assets/:assetId/versions",
  upload.single("file"),
  asyncRoute(async (req, res) => {
    const actor = requireActor(req);
    const asset = await loadAssetWithClient(req.params.assetId);
    if (!asset) throw new NotFoundError("Asset not found");
    if (!asset.deliverableId) throw new NotFoundError("This asset has no deliverable to check permissions against");

    const ctx = await loadDeliverableContext(asset.deliverableId);
    if (!ctx) throw new NotFoundError("Deliverable not found");
    policy.assertCanEditDeliverable(actor, { clientId: ctx.clientId ?? "", deliverableId: ctx.deliverable.id });

    if (!req.file) return res.status(400).json({ error: "No file was uploaded (field name must be 'file')" });

    const [latest] = await db
      .select({ versionNumber: assetVersions.versionNumber })
      .from(assetVersions)
      .where(eq(assetVersions.assetId, asset.id))
      .orderBy(desc(assetVersions.versionNumber))
      .limit(1);
    const nextVersion = (latest?.versionNumber ?? 0) + 1;

    const storageKey = saveFileBuffer({
      workspaceId: actor.workspaceId,
      assetId: asset.id,
      versionNumber: nextVersion,
      originalFilename: req.file.originalname,
      buffer: req.file.buffer,
    });

    const [version] = await db
      .insert(assetVersions)
      .values({
        assetId: asset.id,
        versionNumber: nextVersion,
        storageKey,
        originalFilename: req.file.originalname,
        mimeType: req.file.mimetype,
        sizeBytes: req.file.size,
        uploadedById: actor.userId,
      })
      .returning();

    await db.update(assets).set({ status: "in_review", updatedAt: new Date() }).where(eq(assets.id, asset.id));

    const priorReviewers = await pastFeedbackAuthors(asset.id);
    await notify({
      workspaceId: actor.workspaceId,
      userIds: [...ctx.watcherIds, ...priorReviewers],
      excludeUserId: actor.userId,
      type: "asset.reuploaded",
      title: `${asset.name} was re-uploaded (v${nextVersion})`,
      body: `On "${ctx.deliverable.title}" — ready for another look`,
      link: `/deliverables/${ctx.deliverable.id}`,
    });

    return res.status(201).json({ version });
  }),
);

/** Stream the actual file for a version, after the same view-permission check as everything else. */
assetsRouter.get(
  "/assets/:assetId/versions/:versionId/file",
  asyncRoute(async (req, res) => {
    const actor = requireActor(req);
    const asset = await loadAssetWithClient(req.params.assetId);
    if (!asset) throw new NotFoundError("Asset not found");

    if (asset.deliverableId) {
      const ctx = await loadDeliverableContext(asset.deliverableId);
      if (!ctx) throw new NotFoundError("Deliverable not found");
      policy.assertCanViewDeliverable(actor, { clientId: ctx.clientId ?? "", deliverableId: ctx.deliverable.id });
    } else {
      policy.assertCanViewClient(actor, asset.clientId);
    }

    const [version] = await db
      .select()
      .from(assetVersions)
      .where(and(eq(assetVersions.id, req.params.versionId), eq(assetVersions.assetId, asset.id)))
      .limit(1);
    if (!version) throw new NotFoundError("Version not found");

    return res.sendFile(resolveStoragePath(version.storageKey), {
      headers: { "Content-Type": version.mimeType, "Content-Disposition": `inline; filename="${version.originalFilename}"` },
    });
  }),
);

const feedbackSchema = z.object({
  body: z.string().max(4000).optional(),
  kind: z.enum(["comment", "approved", "changes_requested"]).default("comment"),
});

/** Post feedback or an approve/request-changes decision on an asset. */
assetsRouter.post(
  "/assets/:assetId/feedback",
  asyncRoute(async (req, res) => {
    const actor = requireActor(req);
    const asset = await loadAssetWithClient(req.params.assetId);
    if (!asset) throw new NotFoundError("Asset not found");
    if (!asset.deliverableId) throw new NotFoundError("This asset has no deliverable to check permissions against");

    const ctx = await loadDeliverableContext(asset.deliverableId);
    if (!ctx) throw new NotFoundError("Deliverable not found");

    const body = feedbackSchema.parse(req.body);

    if (body.kind === "comment") {
      policy.assertCanViewDeliverable(actor, { clientId: ctx.clientId ?? "", deliverableId: ctx.deliverable.id });
    } else {
      // Only admins/managers make the approve/request-changes call.
      if (!(actor.role === "admin" || (actor.role === "manager" && ctx.clientId && actor.assignedClientIds.has(ctx.clientId)))) {
        throw new ForbiddenError("Only an admin or the assigned manager can approve or request changes");
      }
      if (!body.body && body.kind === "changes_requested") {
        return res.status(400).json({ error: "Say what needs to change so the designer knows what to fix" });
      }
    }

    const [latest] = await db
      .select({ versionNumber: assetVersions.versionNumber })
      .from(assetVersions)
      .where(eq(assetVersions.assetId, asset.id))
      .orderBy(desc(assetVersions.versionNumber))
      .limit(1);

    const [entry] = await db
      .insert(assetFeedback)
      .values({
        assetId: asset.id,
        versionNumber: latest?.versionNumber ?? 1,
        authorId: actor.userId,
        kind: body.kind,
        body: body.body,
      })
      .returning();

    if (body.kind !== "comment") {
      await db
        .update(assets)
        .set({ status: body.kind === "approved" ? "approved" : "in_review", updatedAt: new Date() })
        .where(eq(assets.id, asset.id));
    }

    const [latestUploader] = await db
      .select({ uploadedById: assetVersions.uploadedById })
      .from(assetVersions)
      .where(eq(assetVersions.assetId, asset.id))
      .orderBy(desc(assetVersions.versionNumber))
      .limit(1);

    const title =
      body.kind === "approved"
        ? `${asset.name} was approved`
        : body.kind === "changes_requested"
          ? `Changes requested on ${asset.name}`
          : `New feedback on ${asset.name}`;

    await notify({
      workspaceId: actor.workspaceId,
      userIds: [...ctx.watcherIds, ...(latestUploader ? [latestUploader.uploadedById] : [])],
      excludeUserId: actor.userId,
      type: `asset.${body.kind}`,
      title,
      body: body.body ?? undefined,
      link: `/deliverables/${ctx.deliverable.id}`,
    });

    return res.status(201).json({ feedback: entry });
  }),
);

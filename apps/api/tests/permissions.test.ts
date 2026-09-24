/**
 * This suite is the "prove it" check for the permission model: it runs every
 * role against the endpoints that must enforce client isolation and
 * freelancer scoping (the plan's PRM-02, PRM-03, PRM-04), plus workspace
 * management being admin-only. It hits the real HTTP app with a real
 * Postgres database, not mocks, so it exercises the actual policy layer and
 * SQL queries together.
 */
import { beforeAll, afterAll, describe, it, expect } from "vitest";
import request from "supertest";
import { createApp } from "../src/app";
import { db, pool } from "../src/db/client";
import { hashPassword } from "../src/lib/auth";
import { DEFAULT_STAGES } from "@agency/shared";
import {
  workspaces,
  stages,
  users,
  clients,
  clientAssignments,
  clientContacts,
  contentItems,
  deliverables,
  deliverableAssignees,
  comments,
  auditLogs,
  checklistItems,
  stageTransitions,
  assets,
  assetVersions,
  assetFeedback,
  notifications,
  invitations,
} from "../src/db/schema";

const app = createApp();
const PASSWORD = "Password123!";

interface Fixture {
  clientAId: string;
  clientBId: string;
  copyDeliverableId: string;
  designDeliverableId: string;
  internalCommentId: string;
  tokens: Record<"admin" | "manager" | "designer" | "freelancer" | "clientA" | "clientB", string>;
}

let fx: Fixture;

async function login(email: string): Promise<string> {
  const res = await request(app).post("/auth/login").send({ email, password: PASSWORD });
  expect(res.status).toBe(200);
  return res.body.token as string;
}

function auth(token: string) {
  return { Authorization: `Bearer ${token}` };
}

async function resetDatabase() {
  await db.delete(auditLogs);
  await db.delete(notifications);
  await db.delete(comments);
  await db.delete(checklistItems);
  await db.delete(stageTransitions);
  await db.delete(deliverableAssignees);
  await db.delete(assetFeedback);
  await db.delete(assetVersions);
  await db.delete(assets);
  await db.delete(deliverables);
  await db.delete(contentItems);
  await db.delete(clientContacts);
  await db.delete(clientAssignments);
  await db.delete(clients);
  await db.delete(invitations);
  await db.delete(stages);
  await db.delete(users);
  await db.delete(workspaces);
}

beforeAll(async () => {
  await resetDatabase();

  const [workspace] = await db.insert(workspaces).values({ name: "Test Agency" }).returning();
  await db.insert(stages).values(
    DEFAULT_STAGES.map((s) => ({ workspaceId: workspace.id, key: s.key, label: s.label, stageType: s.stageType, order: s.order })),
  );
  const stageRows = await db.select().from(stages);
  const stageByKey = new Map(stageRows.map((s) => [s.key, s]));

  const passwordHash = await hashPassword(PASSWORD);
  const [admin] = await db.insert(users).values({ workspaceId: workspace.id, email: "admin@test.local", passwordHash, name: "Admin", role: "admin" }).returning();
  const [manager] = await db.insert(users).values({ workspaceId: workspace.id, email: "manager@test.local", passwordHash, name: "Manager", role: "manager" }).returning();
  const [designer] = await db.insert(users).values({ workspaceId: workspace.id, email: "designer@test.local", passwordHash, name: "Designer", role: "team_member" }).returning();
  const [freelancer] = await db.insert(users).values({ workspaceId: workspace.id, email: "freelancer@test.local", passwordHash, name: "Freelancer", role: "freelancer" }).returning();

  const [clientA] = await db.insert(clients).values({ workspaceId: workspace.id, name: "Client A" }).returning();
  await db.insert(clientAssignments).values([
    { clientId: clientA.id, userId: manager.id },
    { clientId: clientA.id, userId: designer.id },
  ]);
  const [clientB] = await db.insert(clients).values({ workspaceId: workspace.id, name: "Client B" }).returning();

  const [clientAUser] = await db.insert(users).values({ workspaceId: workspace.id, email: "clienta@test.local", passwordHash, name: "Client A Contact", role: "client" }).returning();
  await db.insert(clientContacts).values({ clientId: clientA.id, userId: clientAUser.id });
  const [clientBUser] = await db.insert(users).values({ workspaceId: workspace.id, email: "clientb@test.local", passwordHash, name: "Client B Contact", role: "client" }).returning();
  await db.insert(clientContacts).values({ clientId: clientB.id, userId: clientBUser.id });

  const [contentItem] = await db
    .insert(contentItems)
    .values({ workspaceId: workspace.id, clientId: clientA.id, title: "Test post", channel: "instagram", format: "Single image", publishDate: new Date(), createdById: manager.id })
    .returning();

  const [copyDeliverable] = await db
    .insert(deliverables)
    .values({ workspaceId: workspace.id, contentItemId: contentItem.id, title: "Copy", stageId: stageByKey.get("production")!.id, ownerId: manager.id })
    .returning();
  await db.insert(deliverableAssignees).values({ deliverableId: copyDeliverable.id, userId: designer.id });

  const [designDeliverable] = await db
    .insert(deliverables)
    .values({ workspaceId: workspace.id, contentItemId: contentItem.id, title: "Design", stageId: stageByKey.get("brief")!.id, ownerId: manager.id })
    .returning();
  await db.insert(deliverableAssignees).values({ deliverableId: designDeliverable.id, userId: freelancer.id });

  const [internalComment] = await db
    .insert(comments)
    .values({ deliverableId: copyDeliverable.id, authorId: manager.id, body: "Internal-only note", visibility: "internal" })
    .returning();

  fx = {
    clientAId: clientA.id,
    clientBId: clientB.id,
    copyDeliverableId: copyDeliverable.id,
    designDeliverableId: designDeliverable.id,
    internalCommentId: internalComment.id,
    tokens: {
      admin: await login(admin.email),
      manager: await login(manager.email),
      designer: await login(designer.email),
      freelancer: await login(freelancer.email),
      clientA: await login(clientAUser.email),
      clientB: await login(clientBUser.email),
    },
  };
});

afterAll(async () => {
  await resetDatabase();
  await pool.end();
});

describe("client isolation", () => {
  it("a client can see their own client record", async () => {
    const res = await request(app).get(`/clients/${fx.clientAId}`).set(auth(fx.tokens.clientA));
    expect(res.status).toBe(200);
  });

  it("a client cannot see another client's record", async () => {
    const res = await request(app).get(`/clients/${fx.clientBId}`).set(auth(fx.tokens.clientA));
    expect(res.status).toBe(403);
  });

  it("client A's calendar never includes client B's content, even in the combined feed", async () => {
    const res = await request(app).get("/content-items").set(auth(fx.tokens.clientA));
    expect(res.status).toBe(200);
    const clientIds = res.body.contentItems.map((c: { clientId: string }) => c.clientId);
    expect(clientIds.every((id: string) => id === fx.clientAId)).toBe(true);
  });

  it("admin sees all clients, manager sees only assigned clients", async () => {
    const adminRes = await request(app).get("/clients").set(auth(fx.tokens.admin));
    expect(adminRes.body.clients.length).toBe(2);

    const managerRes = await request(app).get("/clients").set(auth(fx.tokens.manager));
    expect(managerRes.body.clients.map((c: { id: string }) => c.id)).toEqual([fx.clientAId]);
  });
});

describe("freelancer scoping", () => {
  it("a freelancer can view their assigned deliverable", async () => {
    const res = await request(app).get(`/deliverables/${fx.designDeliverableId}`).set(auth(fx.tokens.freelancer));
    expect(res.status).toBe(200);
  });

  it("a freelancer cannot view a deliverable they are not assigned to", async () => {
    const res = await request(app).get(`/deliverables/${fx.copyDeliverableId}`).set(auth(fx.tokens.freelancer));
    expect(res.status).toBe(403);
  });

  it("a freelancer's deliverable list contains only their own assignments", async () => {
    const res = await request(app).get("/deliverables").set(auth(fx.tokens.freelancer));
    expect(res.status).toBe(200);
    expect(res.body.deliverables.map((d: { id: string }) => d.id)).toEqual([fx.designDeliverableId]);
  });

  it("a freelancer sees no general client list", async () => {
    const res = await request(app).get("/clients").set(auth(fx.tokens.freelancer));
    expect(res.status).toBe(200);
    expect(res.body.clients).toEqual([]);
  });
});

describe("internal notes hidden from clients", () => {
  it("a client fetching comments never receives an internal-visibility comment", async () => {
    const res = await request(app).get(`/deliverables/${fx.copyDeliverableId}/comments`).set(auth(fx.tokens.clientA));
    expect(res.status).toBe(200);
    expect(res.body.comments.find((c: { id: string }) => c.id === fx.internalCommentId)).toBeUndefined();
  });

  it("a client cannot post an internal-visibility comment", async () => {
    const res = await request(app)
      .post(`/deliverables/${fx.copyDeliverableId}/comments`)
      .set(auth(fx.tokens.clientA))
      .send({ body: "trying to go internal", visibility: "internal" });
    expect(res.status).toBe(403);
  });

  it("staff can see internal comments", async () => {
    const res = await request(app).get(`/deliverables/${fx.copyDeliverableId}/comments`).set(auth(fx.tokens.manager));
    expect(res.status).toBe(200);
    expect(res.body.comments.some((c: { id: string }) => c.id === fx.internalCommentId)).toBe(true);
  });
});

describe("workspace administration is admin-only", () => {
  it("a manager cannot list all workspace users", async () => {
    const res = await request(app).get("/users").set(auth(fx.tokens.manager));
    expect(res.status).toBe(403);
  });

  it("an admin can list all workspace users", async () => {
    const res = await request(app).get("/users").set(auth(fx.tokens.admin));
    expect(res.status).toBe(200);
    expect(res.body.users.length).toBeGreaterThan(0);
  });

  it("a team member cannot invite a new user", async () => {
    const res = await request(app)
      .post("/users/invite")
      .set(auth(fx.tokens.designer))
      .send({ email: "new@test.local", name: "New Person", role: "team_member", clientIds: [] });
    expect(res.status).toBe(403);
  });
});

describe("editing rights", () => {
  it("a client cannot edit a deliverable", async () => {
    const res = await request(app).patch(`/deliverables/${fx.copyDeliverableId}`).set(auth(fx.tokens.clientA)).send({ title: "Hacked" });
    expect(res.status).toBe(403);
  });

  it("a team member can edit their own assigned deliverable", async () => {
    const res = await request(app).patch(`/deliverables/${fx.copyDeliverableId}`).set(auth(fx.tokens.designer)).send({ title: "Copy v2" });
    expect(res.status).toBe(200);
  });

  it("a freelancer cannot edit a deliverable they are not assigned to", async () => {
    const res = await request(app).patch(`/deliverables/${fx.copyDeliverableId}`).set(auth(fx.tokens.freelancer)).send({ title: "Nope" });
    expect(res.status).toBe(403);
  });
});

describe("unauthenticated access", () => {
  it("is rejected on every protected route", async () => {
    const routes = ["/clients", "/deliverables", "/content-items", "/users", "/reports/stage-summary"];
    for (const route of routes) {
      const res = await request(app).get(route);
      expect(res.status).toBe(401);
    }
  });
});

describe("asset upload, review and notifications", () => {
  let assetId: string;
  let versionId: string;

  it("a freelancer can upload a poster to their assigned deliverable", async () => {
    const res = await request(app)
      .post(`/deliverables/${fx.designDeliverableId}/assets`)
      .set(auth(fx.tokens.freelancer))
      .attach("file", Buffer.from("fake-png-bytes"), { filename: "poster.png", contentType: "image/png" })
      .field("name", "Test Poster");
    expect(res.status).toBe(201);
    expect(res.body.asset.status).toBe("in_review");
    assetId = res.body.asset.id;
    versionId = res.body.asset.versions[0].id;
  });

  it("a freelancer cannot upload to a deliverable they are not assigned to", async () => {
    const res = await request(app)
      .post(`/deliverables/${fx.copyDeliverableId}/assets`)
      .set(auth(fx.tokens.freelancer))
      .attach("file", Buffer.from("x"), { filename: "x.png", contentType: "image/png" });
    expect(res.status).toBe(403);
  });

  it("the manager was notified of the upload", async () => {
    const res = await request(app).get("/notifications").set(auth(fx.tokens.manager));
    expect(res.status).toBe(200);
    expect(res.body.notifications.some((n: { type: string }) => n.type === "asset.uploaded")).toBe(true);
  });

  it("a client can comment but cannot approve or request changes", async () => {
    const commentRes = await request(app)
      .post(`/assets/${assetId}/feedback`)
      .set(auth(fx.tokens.clientA))
      .send({ kind: "comment", body: "Looks good so far" });
    expect(commentRes.status).toBe(201);

    const decisionRes = await request(app).post(`/assets/${assetId}/feedback`).set(auth(fx.tokens.clientA)).send({ kind: "approved" });
    expect(decisionRes.status).toBe(403);
  });

  it("the manager can request changes, and the freelancer is notified", async () => {
    const res = await request(app)
      .post(`/assets/${assetId}/feedback`)
      .set(auth(fx.tokens.manager))
      .send({ kind: "changes_requested", body: "Make the logo bigger" });
    expect(res.status).toBe(201);

    const notifs = await request(app).get("/notifications").set(auth(fx.tokens.freelancer));
    expect(notifs.body.notifications.some((n: { type: string }) => n.type === "asset.changes_requested")).toBe(true);
  });

  it("the freelancer can re-upload a new version, and the manager can then approve it", async () => {
    const uploadRes = await request(app)
      .post(`/assets/${assetId}/versions`)
      .set(auth(fx.tokens.freelancer))
      .attach("file", Buffer.from("v2-bytes"), { filename: "poster-v2.png", contentType: "image/png" });
    expect(uploadRes.status).toBe(201);
    expect(uploadRes.body.version.versionNumber).toBe(2);

    const approveRes = await request(app).post(`/assets/${assetId}/feedback`).set(auth(fx.tokens.manager)).send({ kind: "approved" });
    expect(approveRes.status).toBe(201);
  });

  it("a client cannot download the file for an asset on a client they don't belong to", async () => {
    const res = await request(app).get(`/assets/${assetId}/versions/${versionId}/file`).set(auth(fx.tokens.clientB));
    expect(res.status).toBe(403);
  });

  it("the assigned client can download the file", async () => {
    const res = await request(app).get(`/assets/${assetId}/versions/${versionId}/file`).set(auth(fx.tokens.clientA));
    expect(res.status).toBe(200);
  });
});

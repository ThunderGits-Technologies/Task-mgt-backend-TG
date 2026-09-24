import { DEFAULT_STAGES } from "@agency/shared";
import { db, pool } from "./client";
import { workspaces, stages, users, clients, clientAssignments, clientContacts, contentItems, deliverables, deliverableAssignees, stageTransitions, comments } from "./schema";
import { hashPassword } from "../lib/auth";

async function main() {
  console.log("Seeding demo workspace...");

  const [workspace] = await db.insert(workspaces).values({ name: "Demo Agency" }).returning();

  await db.insert(stages).values(
    DEFAULT_STAGES.map((s) => ({ workspaceId: workspace.id, key: s.key, label: s.label, stageType: s.stageType, order: s.order })),
  );
  const stageRows = await db.select().from(stages);
  const stageByKey = new Map(stageRows.filter((s) => s.workspaceId === workspace.id).map((s) => [s.key, s]));

  const password = await hashPassword("Password123!");

  const [admin] = await db.insert(users).values({ workspaceId: workspace.id, email: "admin@demo.agency", passwordHash: password, name: "Aditi Admin", role: "admin" }).returning();
  const [manager] = await db.insert(users).values({ workspaceId: workspace.id, email: "manager@demo.agency", passwordHash: password, name: "Manav Manager", role: "manager" }).returning();
  const [designer] = await db.insert(users).values({ workspaceId: workspace.id, email: "designer@demo.agency", passwordHash: password, name: "Divya Designer", role: "team_member" }).returning();
  const [freelancer] = await db.insert(users).values({ workspaceId: workspace.id, email: "freelancer@demo.agency", passwordHash: password, name: "Farhan Freelancer", role: "freelancer" }).returning();

  const [clientA] = await db.insert(clients).values({ workspaceId: workspace.id, name: "Zenith Foods", brandColor: "#2563eb" }).returning();
  await db.insert(clientAssignments).values([
    { clientId: clientA.id, userId: manager.id },
    { clientId: clientA.id, userId: designer.id },
  ]);
  const [clientB] = await db.insert(clients).values({ workspaceId: workspace.id, name: "Orbit Fintech", brandColor: "#16a34a" }).returning();
  void clientB;

  const [clientUser] = await db.insert(users).values({ workspaceId: workspace.id, email: "client@zenithfoods.com", passwordHash: password, name: "Priya (Zenith Foods)", role: "client" }).returning();
  await db.insert(clientContacts).values({ clientId: clientA.id, userId: clientUser.id });

  const [item] = await db
    .insert(contentItems)
    .values({
      workspaceId: workspace.id,
      clientId: clientA.id,
      title: "Diwali gifting carousel",
      channel: "instagram",
      format: "Carousel (5 slides)",
      publishDate: new Date(Date.now() + 5 * 24 * 60 * 60 * 1000),
      createdById: manager.id,
    })
    .returning();

  const [copyDeliverable] = await db
    .insert(deliverables)
    .values({
      workspaceId: workspace.id,
      contentItemId: item.id,
      title: "Write carousel copy",
      dueDate: new Date(Date.now() + 1 * 24 * 60 * 60 * 1000),
      priority: "high",
      stageId: stageByKey.get("production")!.id,
      ownerId: manager.id,
    })
    .returning();
  await db.insert(deliverableAssignees).values({ deliverableId: copyDeliverable.id, userId: designer.id });
  await db.insert(stageTransitions).values({ deliverableId: copyDeliverable.id, toStageId: stageByKey.get("production")!.id, changedById: manager.id });

  const [designDeliverable] = await db
    .insert(deliverables)
    .values({
      workspaceId: workspace.id,
      contentItemId: item.id,
      title: "Design carousel slides",
      dueDate: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000),
      priority: "high",
      stageId: stageByKey.get("brief")!.id,
      ownerId: manager.id,
      blockedById: copyDeliverable.id,
    })
    .returning();
  await db.insert(deliverableAssignees).values({ deliverableId: designDeliverable.id, userId: freelancer.id });
  await db.insert(stageTransitions).values({ deliverableId: designDeliverable.id, toStageId: stageByKey.get("brief")!.id, changedById: manager.id });

  await db.insert(comments).values({ deliverableId: copyDeliverable.id, authorId: manager.id, body: "Keep it under 40 words per slide.", visibility: "internal" });

  console.log("Seed complete. Demo logins (password: Password123!):");
  console.log("  admin@demo.agency (admin)");
  console.log("  manager@demo.agency (manager, assigned to Zenith Foods)");
  console.log("  designer@demo.agency (team_member, assigned to Zenith Foods)");
  console.log("  freelancer@demo.agency (freelancer, assigned only to the design task)");
  console.log("  client@zenithfoods.com (client, Zenith Foods only)");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => pool.end());

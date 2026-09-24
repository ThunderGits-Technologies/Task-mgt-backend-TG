import {
  pgTable,
  pgEnum,
  uuid,
  text,
  timestamp,
  integer,
  boolean,
  jsonb,
  uniqueIndex,
  index,
} from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";

export const roleEnum = pgEnum("role", ["admin", "manager", "team_member", "freelancer", "client"]);
export const membershipStatusEnum = pgEnum("membership_status", ["active", "invited", "suspended"]);
export const stageTypeEnum = pgEnum("stage_type", ["backlog", "in_progress", "internal_review", "client_review", "done"]);
export const priorityEnum = pgEnum("priority", ["low", "medium", "high", "urgent"]);
export const assetStatusEnum = pgEnum("asset_status", ["draft", "in_review", "approved", "delivered"]);
export const channelEnum = pgEnum("channel", ["instagram", "facebook", "linkedin", "x", "youtube", "blog", "email", "ads", "other"]);
export const contentStatusEnum = pgEnum("content_status", ["planned", "in_production", "ready", "scheduled", "published"]);
export const commentVisibilityEnum = pgEnum("comment_visibility", ["internal", "client_visible"]);

export const workspaces = pgTable("workspaces", {
  id: uuid("id").defaultRandom().primaryKey(),
  name: text("name").notNull(),
  timezone: text("timezone").notNull().default("Asia/Kolkata"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const users = pgTable(
  "users",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
    email: text("email").notNull(),
    passwordHash: text("password_hash").notNull(),
    name: text("name").notNull(),
    role: roleEnum("role").notNull(),
    status: membershipStatusEnum("status").notNull().default("active"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => ({
    emailPerWorkspace: uniqueIndex("users_workspace_email_idx").on(t.workspaceId, t.email),
    roleIdx: index("users_role_idx").on(t.workspaceId, t.role),
  }),
);

export const invitations = pgTable(
  "invitations",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
    email: text("email").notNull(),
    name: text("name").notNull(),
    role: roleEnum("role").notNull(),
    clientIds: text("client_ids").array().notNull().default([]),
    token: text("token").notNull(),
    invitedById: uuid("invited_by_id"),
    acceptedAt: timestamp("accepted_at"),
    expiresAt: timestamp("expires_at").notNull(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => ({
    tokenIdx: uniqueIndex("invitations_token_idx").on(t.token),
  }),
);

export const clients = pgTable(
  "clients",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    brandColor: text("brand_color"),
    archived: boolean("archived").notNull().default(false),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => ({ workspaceIdx: index("clients_workspace_idx").on(t.workspaceId) }),
);

export const clientAssignments = pgTable(
  "client_assignments",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    clientId: uuid("client_id").notNull().references(() => clients.id, { onDelete: "cascade" }),
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => ({
    unique: uniqueIndex("client_assignments_client_user_idx").on(t.clientId, t.userId),
    userIdx: index("client_assignments_user_idx").on(t.userId),
  }),
);

export const clientContacts = pgTable(
  "client_contacts",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    clientId: uuid("client_id").notNull().references(() => clients.id, { onDelete: "cascade" }),
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => ({
    userUnique: uniqueIndex("client_contacts_user_idx").on(t.userId),
    clientIdx: index("client_contacts_client_idx").on(t.clientId),
  }),
);

export const stages = pgTable(
  "stages",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
    key: text("key").notNull(),
    label: text("label").notNull(),
    stageType: stageTypeEnum("stage_type").notNull(),
    order: integer("order").notNull(),
  },
  (t) => ({
    unique: uniqueIndex("stages_workspace_key_idx").on(t.workspaceId, t.key),
  }),
);

export const contentItems = pgTable(
  "content_items",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
    clientId: uuid("client_id").notNull().references(() => clients.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    channel: channelEnum("channel").notNull(),
    format: text("format").notNull(),
    publishDate: timestamp("publish_date").notNull(),
    status: contentStatusEnum("status").notNull().default("planned"),
    createdById: uuid("created_by_id").notNull(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => ({
    idx: index("content_items_workspace_client_date_idx").on(t.workspaceId, t.clientId, t.publishDate),
  }),
);

export const deliverables = pgTable(
  "deliverables",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
    contentItemId: uuid("content_item_id").references(() => contentItems.id, { onDelete: "set null" }),
    title: text("title").notNull(),
    description: text("description"),
    dueDate: timestamp("due_date"),
    priority: priorityEnum("priority").notNull().default("medium"),
    stageId: uuid("stage_id").notNull().references(() => stages.id),
    ownerId: uuid("owner_id").notNull(),
    parentId: uuid("parent_id"),
    blockedById: uuid("blocked_by_id"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => ({
    stageIdx: index("deliverables_workspace_stage_idx").on(t.workspaceId, t.stageId),
    dueIdx: index("deliverables_workspace_due_idx").on(t.workspaceId, t.dueDate),
  }),
);

export const deliverableAssignees = pgTable(
  "deliverable_assignees",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    deliverableId: uuid("deliverable_id").notNull().references(() => deliverables.id, { onDelete: "cascade" }),
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  },
  (t) => ({
    unique: uniqueIndex("deliverable_assignees_unique_idx").on(t.deliverableId, t.userId),
  }),
);

export const checklistItems = pgTable(
  "checklist_items",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    deliverableId: uuid("deliverable_id").notNull().references(() => deliverables.id, { onDelete: "cascade" }),
    label: text("label").notNull(),
    done: boolean("done").notNull().default(false),
    order: integer("order").notNull().default(0),
  },
  (t) => ({ idx: index("checklist_items_deliverable_idx").on(t.deliverableId) }),
);

export const stageTransitions = pgTable(
  "stage_transitions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    deliverableId: uuid("deliverable_id").notNull().references(() => deliverables.id, { onDelete: "cascade" }),
    fromStageId: uuid("from_stage_id"),
    toStageId: uuid("to_stage_id").notNull(),
    changedById: uuid("changed_by_id").notNull(),
    changedAt: timestamp("changed_at").notNull().defaultNow(),
  },
  (t) => ({ idx: index("stage_transitions_deliverable_idx").on(t.deliverableId, t.changedAt) }),
);

export const comments = pgTable(
  "comments",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    deliverableId: uuid("deliverable_id").notNull().references(() => deliverables.id, { onDelete: "cascade" }),
    authorId: uuid("author_id").notNull().references(() => users.id),
    body: text("body").notNull(),
    visibility: commentVisibilityEnum("visibility").notNull().default("internal"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => ({ idx: index("comments_deliverable_idx").on(t.deliverableId, t.createdAt) }),
);

export const assets = pgTable(
  "assets",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
    clientId: uuid("client_id").notNull().references(() => clients.id, { onDelete: "cascade" }),
    deliverableId: uuid("deliverable_id").references(() => deliverables.id, { onDelete: "set null" }),
    name: text("name").notNull(),
    status: assetStatusEnum("status").notNull().default("draft"),
    tags: text("tags").array().notNull().default([]),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => ({ idx: index("assets_workspace_client_idx").on(t.workspaceId, t.clientId) }),
);

export const assetVersions = pgTable(
  "asset_versions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    assetId: uuid("asset_id").notNull().references(() => assets.id, { onDelete: "cascade" }),
    versionNumber: integer("version_number").notNull(),
    storageKey: text("storage_key").notNull(),
    originalFilename: text("original_filename").notNull(),
    mimeType: text("mime_type").notNull(),
    sizeBytes: integer("size_bytes").notNull(),
    uploadedById: uuid("uploaded_by_id").notNull(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => ({ unique: uniqueIndex("asset_versions_asset_version_idx").on(t.assetId, t.versionNumber) }),
);

export const assetFeedbackKindEnum = pgEnum("asset_feedback_kind", ["comment", "approved", "changes_requested"]);

/** Feedback and approve/request-changes decisions on a specific asset version. */
export const assetFeedback = pgTable(
  "asset_feedback",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    assetId: uuid("asset_id").notNull().references(() => assets.id, { onDelete: "cascade" }),
    versionNumber: integer("version_number").notNull(),
    authorId: uuid("author_id").notNull().references(() => users.id),
    kind: assetFeedbackKindEnum("kind").notNull().default("comment"),
    body: text("body"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => ({ idx: index("asset_feedback_asset_idx").on(t.assetId, t.createdAt) }),
);

/** In-app notifications: uploads, feedback, and decisions surface here for the people who need to act. */
export const notifications = pgTable(
  "notifications",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    type: text("type").notNull(),
    title: text("title").notNull(),
    body: text("body"),
    link: text("link"),
    read: boolean("read").notNull().default(false),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => ({ idx: index("notifications_user_idx").on(t.userId, t.read, t.createdAt) }),
);

export const auditLogs = pgTable(
  "audit_logs",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
    actorId: uuid("actor_id"),
    action: text("action").notNull(),
    targetType: text("target_type").notNull(),
    targetId: text("target_id").notNull(),
    metadata: jsonb("metadata"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => ({ idx: index("audit_logs_workspace_idx").on(t.workspaceId, t.createdAt) }),
);

// --- relations (used for the query API's `with` includes) ---

export const usersRelations = relations(users, ({ many, one }) => ({
  clientAssignments: many(clientAssignments),
  clientContact: one(clientContacts, { fields: [users.id], references: [clientContacts.userId] }),
}));

export const clientsRelations = relations(clients, ({ many }) => ({
  assignments: many(clientAssignments),
  contentItems: many(contentItems),
}));

export const clientAssignmentsRelations = relations(clientAssignments, ({ one }) => ({
  client: one(clients, { fields: [clientAssignments.clientId], references: [clients.id] }),
  user: one(users, { fields: [clientAssignments.userId], references: [users.id] }),
}));

export const contentItemsRelations = relations(contentItems, ({ one, many }) => ({
  client: one(clients, { fields: [contentItems.clientId], references: [clients.id] }),
  deliverables: many(deliverables),
}));

export const deliverablesRelations = relations(deliverables, ({ one, many }) => ({
  contentItem: one(contentItems, { fields: [deliverables.contentItemId], references: [contentItems.id] }),
  stage: one(stages, { fields: [deliverables.stageId], references: [stages.id] }),
  owner: one(users, { fields: [deliverables.ownerId], references: [users.id] }),
  blockedBy: one(deliverables, { fields: [deliverables.blockedById], references: [deliverables.id] }),
  assignees: many(deliverableAssignees),
  comments: many(comments),
  checklistItems: many(checklistItems),
  stageTransitions: many(stageTransitions),
  assets: many(assets),
}));

export const deliverableAssigneesRelations = relations(deliverableAssignees, ({ one }) => ({
  deliverable: one(deliverables, { fields: [deliverableAssignees.deliverableId], references: [deliverables.id] }),
  user: one(users, { fields: [deliverableAssignees.userId], references: [users.id] }),
}));

export const commentsRelations = relations(comments, ({ one }) => ({
  author: one(users, { fields: [comments.authorId], references: [users.id] }),
  deliverable: one(deliverables, { fields: [comments.deliverableId], references: [deliverables.id] }),
}));

export const checklistItemsRelations = relations(checklistItems, ({ one }) => ({
  deliverable: one(deliverables, { fields: [checklistItems.deliverableId], references: [deliverables.id] }),
}));

export const stageTransitionsRelations = relations(stageTransitions, ({ one }) => ({
  deliverable: one(deliverables, { fields: [stageTransitions.deliverableId], references: [deliverables.id] }),
}));

export const assetsRelations = relations(assets, ({ one, many }) => ({
  client: one(clients, { fields: [assets.clientId], references: [clients.id] }),
  deliverable: one(deliverables, { fields: [assets.deliverableId], references: [deliverables.id] }),
  versions: many(assetVersions),
  feedback: many(assetFeedback),
}));

export const assetVersionsRelations = relations(assetVersions, ({ one }) => ({
  asset: one(assets, { fields: [assetVersions.assetId], references: [assets.id] }),
  uploadedBy: one(users, { fields: [assetVersions.uploadedById], references: [users.id] }),
}));

export const assetFeedbackRelations = relations(assetFeedback, ({ one }) => ({
  asset: one(assets, { fields: [assetFeedback.assetId], references: [assets.id] }),
  author: one(users, { fields: [assetFeedback.authorId], references: [users.id] }),
}));


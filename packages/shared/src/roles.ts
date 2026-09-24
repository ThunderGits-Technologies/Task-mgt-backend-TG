/**
 * Roles and permission model shared by the API (server-side enforcement)
 * and the web app (UI hints only — the API is the source of truth).
 */

export const ROLES = [
  "admin",
  "manager",
  "team_member",
  "freelancer",
  "client",
] as const;

export type Role = (typeof ROLES)[number];

/**
 * Every action the system enforces access for. Kept as a flat, explicit list
 * so a permission test can iterate every (role x action) pair deliberately,
 * rather than relying on wildcard logic that is easy to get wrong.
 */
export const ACTIONS = [
  "workspace.manage_settings",
  "workspace.manage_roles",
  "client.create",
  "client.view_any",
  "client.view_assigned",
  "client.view_own", // client role viewing their own account
  "client.edit",
  "client.delete",
  "user.invite",
  "user.remove",
  "content_item.create",
  "content_item.view",
  "content_item.edit",
  "content_item.delete",
  "deliverable.create",
  "deliverable.view",
  "deliverable.edit_any",
  "deliverable.edit_own", // freelancer/team member updating only their assigned task
  "deliverable.delete",
  "comment.create_internal",
  "comment.view_internal",
  "comment.create_client_visible",
  "report.view_any",
  "report.view_assigned_clients",
  "report.view_own_workload",
  "report.view_own_client",
] as const;

export type Action = (typeof ACTIONS)[number];

/**
 * Static, role-level allow list. This is deliberately coarse — it says what a
 * role is CAPABLE of. Row-level checks (does this manager's assignment cover
 * THIS client? does this freelancer own THIS deliverable? is this client
 * account THEIR OWN?) happen in the policy layer on top of this table, never
 * in the UI alone.
 */
export const ROLE_ACTIONS: Record<Role, ReadonlySet<Action>> = {
  admin: new Set(ACTIONS), // admins can do everything listed
  manager: new Set<Action>([
    "client.create",
    "client.view_assigned",
    "client.edit",
    "user.invite",
    "content_item.create",
    "content_item.view",
    "content_item.edit",
    "content_item.delete",
    "deliverable.create",
    "deliverable.view",
    "deliverable.edit_any",
    "deliverable.delete",
    "comment.create_internal",
    "comment.view_internal",
    "comment.create_client_visible",
    "report.view_assigned_clients",
    "report.view_own_workload",
  ]),
  team_member: new Set<Action>([
    "client.view_assigned",
    "content_item.view",
    "content_item.create",
    "content_item.edit",
    "deliverable.create",
    "deliverable.view",
    "deliverable.edit_own",
    "comment.create_internal",
    "comment.view_internal",
    "comment.create_client_visible",
    "report.view_own_workload",
  ]),
  freelancer: new Set<Action>([
    "deliverable.view",
    "deliverable.edit_own",
    "comment.create_internal",
    "comment.view_internal",
    "report.view_own_workload",
  ]),
  client: new Set<Action>([
    "client.view_own",
    "content_item.view",
    "deliverable.view",
    "comment.create_client_visible",
    "report.view_own_client",
  ]),
};

export function roleCan(role: Role, action: Action): boolean {
  return ROLE_ACTIONS[role].has(action);
}

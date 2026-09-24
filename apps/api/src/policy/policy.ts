import { roleCan, type Action } from "@agency/shared";
import type { ActorScope } from "./actorScope";

export class ForbiddenError extends Error {
  constructor(message = "Forbidden") {
    super(message);
    this.name = "ForbiddenError";
  }
}

/** Deny-by-default: an action not explicitly granted to a role never passes. */
function requireRoleAction(scope: ActorScope, action: Action) {
  if (!roleCan(scope.role, action)) {
    throw new ForbiddenError(`Role '${scope.role}' cannot perform '${action}'`);
  }
}

export const policy = {
  canManageWorkspace(scope: ActorScope) {
    requireRoleAction(scope, "workspace.manage_roles");
  },

  canInviteUser(scope: ActorScope) {
    requireRoleAction(scope, "user.invite");
  },

  /** True if this staff/freelancer/client user may see the given client at all. */
  canViewClient(scope: ActorScope, clientId: string): boolean {
    if (scope.role === "admin") return true;
    if (scope.role === "client") return scope.ownClientId === clientId;
    if (scope.role === "manager" || scope.role === "team_member") {
      return scope.assignedClientIds.has(clientId);
    }
    // Freelancers have no general client view — only through assigned deliverables.
    return false;
  },

  assertCanViewClient(scope: ActorScope, clientId: string) {
    if (!this.canViewClient(scope, clientId)) {
      throw new ForbiddenError("You do not have access to this client");
    }
  },

  canCreateContentItem(scope: ActorScope, clientId: string): boolean {
    requireRoleAction(scope, "content_item.create");
    return this.canViewClient(scope, clientId);
  },

  assertCanCreateContentItem(scope: ActorScope, clientId: string) {
    if (!this.canCreateContentItem(scope, clientId)) {
      throw new ForbiddenError("You cannot create content for this client");
    }
  },

  /** Can this user see the given deliverable, whichever client/content item it belongs to? */
  canViewDeliverable(scope: ActorScope, params: { clientId: string; deliverableId: string }): boolean {
    requireRoleAction(scope, "deliverable.view");
    if (scope.role === "admin") return true;
    if (scope.role === "manager" || scope.role === "team_member") {
      return scope.assignedClientIds.has(params.clientId);
    }
    if (scope.role === "freelancer") {
      return scope.assignedDeliverableIds.has(params.deliverableId);
    }
    if (scope.role === "client") {
      return scope.ownClientId === params.clientId;
    }
    return false;
  },

  assertCanViewDeliverable(scope: ActorScope, params: { clientId: string; deliverableId: string }) {
    if (!this.canViewDeliverable(scope, params)) {
      throw new ForbiddenError("You do not have access to this deliverable");
    }
  },

  /** Can this user edit (status, fields) the given deliverable? */
  canEditDeliverable(scope: ActorScope, params: { clientId: string; deliverableId: string }): boolean {
    if (scope.role === "admin") return true;
    if (scope.role === "manager") {
      return roleCan(scope.role, "deliverable.edit_any") && scope.assignedClientIds.has(params.clientId);
    }
    if (scope.role === "team_member" || scope.role === "freelancer") {
      return roleCan(scope.role, "deliverable.edit_own") && scope.assignedDeliverableIds.has(params.deliverableId);
    }
    // Clients never edit deliverables directly — only review/comment (Stage 2).
    return false;
  },

  assertCanEditDeliverable(scope: ActorScope, params: { clientId: string; deliverableId: string }) {
    if (!this.canEditDeliverable(scope, params)) {
      throw new ForbiddenError("You cannot edit this deliverable");
    }
  },

  /** Internal notes/comments must never be visible to a client. */
  canViewInternalComments(scope: ActorScope): boolean {
    return roleCan(scope.role, "comment.view_internal");
  },

  canViewWorkspaceReports(scope: ActorScope): boolean {
    return roleCan(scope.role, "report.view_any");
  },
};

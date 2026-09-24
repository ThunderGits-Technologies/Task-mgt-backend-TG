import { eq } from "drizzle-orm";
import type { Role } from "@agency/shared";
import { db } from "../db/client";
import { clientAssignments, clientContacts, deliverableAssignees } from "../db/schema";

/**
 * Everything the policy layer needs to know about the calling user, loaded
 * once per request. This is the row-level half of access control: the
 * shared ROLE_ACTIONS table says what a role can do in general, this says
 * which specific clients/deliverables THIS user's role-level permission
 * actually applies to.
 */
export interface ActorScope {
  userId: string;
  workspaceId: string;
  role: Role;
  /** Client IDs a manager/team_member is assigned to. Empty for other roles. */
  assignedClientIds: Set<string>;
  /** The single client account this user belongs to, if role === "client". */
  ownClientId: string | null;
  /** Deliverable IDs this user is directly assigned to (freelancer scoping). */
  assignedDeliverableIds: Set<string>;
}

export async function loadActorScope(userId: string, workspaceId: string, role: Role): Promise<ActorScope> {
  const [assignments, clientContactRows, deliverableAssignmentRows] = await Promise.all([
    db.select({ clientId: clientAssignments.clientId }).from(clientAssignments).where(eq(clientAssignments.userId, userId)),
    db.select({ clientId: clientContacts.clientId }).from(clientContacts).where(eq(clientContacts.userId, userId)),
    db.select({ deliverableId: deliverableAssignees.deliverableId }).from(deliverableAssignees).where(eq(deliverableAssignees.userId, userId)),
  ]);

  return {
    userId,
    workspaceId,
    role,
    assignedClientIds: new Set(assignments.map((a) => a.clientId)),
    ownClientId: clientContactRows[0]?.clientId ?? null,
    assignedDeliverableIds: new Set(deliverableAssignmentRows.map((d) => d.deliverableId)),
  };
}

import { eq, inArray } from "drizzle-orm";
import type { Role } from "@agency/shared";
import { db } from "../db/client";
import { clientAssignments, clientContacts, deliverableAssignees, deliverables, contentItems } from "../db/schema";

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

  const assignedClientIds = new Set(assignments.map((a) => a.clientId));
  const assignedDeliverableIds = new Set(deliverableAssignmentRows.map((d) => d.deliverableId));

  // A manager/team_member should also count as "assigned" to a client if
  // they're personally assigned to any task for that client, even without a
  // formal client_assignments row (e.g. a one-off task handed to them).
  if ((role === "manager" || role === "team_member") && assignedDeliverableIds.size > 0) {
    const deliverableIds = Array.from(assignedDeliverableIds);
    const rows = await db
      .select({ clientId: deliverables.clientId, contentItemClientId: contentItems.clientId })
      .from(deliverables)
      .leftJoin(contentItems, eq(deliverables.contentItemId, contentItems.id))
      .where(inArray(deliverables.id, deliverableIds));

    for (const r of rows) {
      const clientId = r.clientId ?? r.contentItemClientId;
      if (clientId) assignedClientIds.add(clientId);
    }
  }

  return {
    userId,
    workspaceId,
    role,
    assignedClientIds,
    ownClientId: clientContactRows[0]?.clientId ?? null,
    assignedDeliverableIds,
  };
}
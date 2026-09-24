import { db } from "../db/client";
import { notifications } from "../db/schema";

interface NotifyParams {
  workspaceId: string;
  userIds: Iterable<string>;
  excludeUserId?: string;
  type: string;
  title: string;
  body?: string;
  link?: string;
}

/** Fans a notification out to several users at once, skipping the actor who triggered it. */
export async function notify({ workspaceId, userIds, excludeUserId, type, title, body, link }: NotifyParams) {
  const recipients = Array.from(new Set(userIds)).filter((id) => id !== excludeUserId);
  if (recipients.length === 0) return;

  await db.insert(notifications).values(
    recipients.map((userId) => ({ workspaceId, userId, type, title, body, link })),
  );
}

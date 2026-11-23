import { sql } from "drizzle-orm";

/** The materialized dependency acquires project -> chat locks in one statement.
 * This matches project-policy fanout and does not rely on join-plan lock order.
 */
export function projectChatExecutionLock(ownerId: string, chatId: string) {
  return sql`
    WITH locked_project AS MATERIALIZED (
      SELECT projects.id FROM projects
      INNER JOIN chats ON chats.project_id = projects.id
      WHERE projects.owner_id = ${ownerId} AND chats.id = ${chatId}
      FOR UPDATE OF projects
    )
    SELECT chats.id FROM locked_project
    INNER JOIN chats ON chats.project_id = locked_project.id
    WHERE chats.id = ${chatId}
    FOR UPDATE OF chats
  `;
}

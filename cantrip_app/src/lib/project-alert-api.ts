import {
  agentInteractionRequestWireSchema,
  projectAlertPageSchema,
  projectAlertDetailSchema,
  projectGoalSnapshotSchema,
  type ProjectAlert,
} from "@cantrip/protocol";
import { request } from "./api-client";
import { openEncryptedAgentInteractionRequest } from "./interaction-encryption";
import { openEndpointContent } from "./endpoint-content-encryption";
import { openChatGoalObjective } from "./chat-message-encryption";
export async function getProjectAlerts(
  projectId: string,
  after: string | null = null,
) {
  const query = new URLSearchParams({ limit: "25" });
  if (after) query.set("after", after);
  return projectAlertPageSchema.parse(
    await request(
      `/api/projects/${encodeURIComponent(projectId)}/alerts?${query}`,
    ),
  );
}
export async function getAlertInteraction(requestId: string) {
  const value = agentInteractionRequestWireSchema.parse(
    await request(`/api/agent-requests/${encodeURIComponent(requestId)}`),
  );
  return "protectedPayload" in value
    ? openEncryptedAgentInteractionRequest(value)
    : value;
}
export async function getAgentAlertDetail(alert: ProjectAlert) {
  if (!alert.protectedDetail)
    throw new Error("Protected Alert details are unavailable.");
  const { context, protectedContent } = alert.protectedDetail;
  return openEndpointContent({
    context,
    opaque: protectedContent,
    schema: projectAlertDetailSchema,
  });
}
export async function getAlertGoal(alert: ProjectAlert) {
  const snapshot = projectGoalSnapshotSchema.parse(
    await request(
      `/api/projects/${encodeURIComponent(alert.projectId)}/alerts/${encodeURIComponent(alert.id)}/goal`,
    ),
  );
  return snapshot.goal
    ? {
        ...snapshot.goal,
        objective: await openChatGoalObjective(
          snapshot.goal.protectedObjective,
        ),
      }
    : null;
}

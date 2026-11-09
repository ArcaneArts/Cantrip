import type { WorkerEvent } from "@cantrip/protocol";

export function workerObservationTurnId(event: WorkerEvent): string | null {
  switch (event.type) {
    case "agent.activity":
      return event.activity.correlation?.turnId ?? null;
    case "agent.message":
      return event.message.correlation?.turnId ?? null;
    case "agent.protected-message":
    case "agent.protected-task-message":
      return event.telemetry.turnId;
    default:
      return null;
  }
}

export function workerObservationMessageId(event: WorkerEvent): string | null {
  switch (event.type) {
    case "agent.activity":
      return event.activity.id;
    case "agent.message":
      return event.message.id;
    case "agent.protected-message":
    case "agent.protected-task-message":
      return event.message.id;
    case "agent.inference-progress":
      return event.progress.requestId;
    default:
      return null;
  }
}

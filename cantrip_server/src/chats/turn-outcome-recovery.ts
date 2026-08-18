export interface ChatTurnOutcomeLane {
  state: string;
  workerId: string;
  worktreeId: string;
}

export function chatTurnOutcomeRecoveryKey(
  workerId: string,
  chatId: string,
  clientMessageId: string,
): string {
  return `${workerId}:${chatId}:${clientMessageId}`;
}

export function shouldRecoverChatTurnOutcome(
  lane: ChatTurnOutcomeLane | null,
  workerId: string,
  worktreeId: string,
): boolean {
  return (
    lane?.state === "active" &&
    lane.workerId === workerId &&
    lane.worktreeId === worktreeId
  );
}

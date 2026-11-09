import type { TerminalServerMessage, WorkerEvent } from "@cantrip/protocol";

type TerminalOutputEvent = Extract<WorkerEvent, { type: "terminal.output" }>;
type TerminalOutputMessage = Extract<TerminalServerMessage, { type: "output" }>;

export function terminalRelayOutputMessage(
  event: TerminalOutputEvent,
): TerminalOutputMessage {
  return {
    type: "output",
    operationId: event.operationId,
    sequence: event.sequence,
    protectedData: event.protectedData,
  };
}

import {
  hydrateCanonicalChat,
  requiredSkillsForCanonicalPayload,
} from "../../cantrip_server/src/chats/hydration.ts";

export async function chatHydrationFixture(r) {
  const trace = [];
  const bridge = {
    async request(worker, command, options) {
      trace.push({ worker, command, options });
      if (
        r.failCommand === command.type &&
        (command.type !== "chat.relocation.hydration.chunk" ||
          r.failChunkIndex === undefined ||
          r.failChunkIndex === command.chunkIndex)
      )
        throw new Error("Controlled hydration worker failure");
      if (r.omitResponse === command.type) return undefined;
      if (r.responses && Object.hasOwn(r.responses, command.type))
        return r.responses[command.type];
      switch (command.type) {
        case "chat.relocation.hydration.begin":
          return { status: "upload" };
        case "chat.relocation.hydration.chunk":
          return null;
        case "chat.relocation.hydration.complete":
          return {
            snapshotId: command.snapshotId,
            transcriptSha256:
              trace.find(
                (call) =>
                  call.command.type === "chat.relocation.hydration.begin",
              )?.command.transcriptSha256 ?? null,
            threadId: "hydrated-thread",
            reused: false,
          };
        default:
          throw new Error("Unexpected hydration fixture command");
      }
    },
  };
  try {
    const value =
      r.op === "relocation-skills"
        ? requiredSkillsForCanonicalPayload(r.payload)
        : await hydrateCanonicalChat({ ...r.input, bridge });
    return { value, error: null, trace };
  } catch (error) {
    return {
      value: null,
      error: { code: error.code ?? null, message: error.message },
      trace,
    };
  }
}

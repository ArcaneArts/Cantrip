import type { WorkerCommand } from "@cantrip/protocol";
import type {
  CodexAppServer,
  RuntimeSubagentDefaults,
} from "../codex/app-server.js";
import type { RuntimeProvider } from "../protected-secrets.js";

// Native runtime creation, namespace selection and shutdown remain in the worker.
export type CommandRuntimeFor = (
  target: {
    threadId?: string | null;
    chatId?: string | null;
    executionProfile?: "ide" | "standalone-chat";
    standaloneSkillRoot?: string | null;
    model: Extract<WorkerCommand, { type: "chat.turn" }>["model"];
    provider: RuntimeProvider;
    subagentDefaults?: RuntimeSubagentDefaults | null;
  },
  stagingOperationId?: string,
) => CodexAppServer;

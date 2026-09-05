import { z } from "zod";
import { workerCoreCommandSchemas } from "./worker-command-core.js";
import { workerGithubProjectCommandSchemas } from "./worker-command-github-project.js";
import { workerGitCommandSchemas } from "./worker-command-git.js";
import { workerWorktreeCodeCommandSchemas } from "./worker-command-worktree-code.js";
import { workerSurfaceCommandSchemas } from "./worker-command-surfaces.js";
import { workerChatCommandSchemas } from "./worker-command-chat.js";
import { workerComputerUseCommandSchema } from "./worker-command-computer-use.js";

export const workerCommandSchema = z.discriminatedUnion("type", [
  workerComputerUseCommandSchema,
  ...workerCoreCommandSchemas,
  ...workerGithubProjectCommandSchemas,
  ...workerGitCommandSchemas,
  ...workerWorktreeCodeCommandSchemas,
  ...workerSurfaceCommandSchemas,
  ...workerChatCommandSchemas,
]);

export type WorkerCommand = z.infer<typeof workerCommandSchema>;

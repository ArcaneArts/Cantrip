// Development oracle follows the Node worker's actual command normalization.
import { workerCommandSchema } from "../../packages/protocol/dist/index.js";
import { handleGitCommand } from "../../cantrip_worker/src/commands/git.ts";
export function nodeGit(cwd, type, arguments_) {
  return handleGitCommand(
    workerCommandSchema.parse({ ...arguments_, type, cwd }),
  );
}

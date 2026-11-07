import { z } from "zod";
import { generateLabelCommandSchema } from "./labeling.js";
import { workerCoreCommandSchemas } from "./worker-command-core.js";
import { workerGithubProjectCommandSchemas } from "./worker-command-github-project.js";
import { workerGitCommandSchemas } from "./worker-command-git.js";
import { workerWorktreeCommandSchemas } from "./worker-command-worktrees.js";
import { workerSurfaceCommandSchemas } from "./worker-command-surfaces.js";
import { workerChatCommandSchemas } from "./worker-command-chat.js";
import { workerCantripOsCommandSchemas } from "./worker-command-cantrip-os.js";
import { workerCantripOsPowerCommandSchemas } from "./cantrip-os-power.js";
import { workerCantripOsPackageCommandSchemas } from "./cantrip-os-packages.js";
import { workerCantripOsSystemCommandSchemas } from "./cantrip-os-system-operations.js";
import { workerCantripOsDesktopCommandSchemas } from "./cantrip-os-desktop.js";
import { workerCantripOsBackupCommandSchemas } from "./cantrip-os-backup-operations.js";
import {
  cantripOsRunDefinitionWorkerCommandSchema,
  workerCantripOsRunCommandSchemas,
} from "./cantrip-os-run.js";
import {
  workerComputerUseEffectsCommandSchema,
  workerComputerUseCommandSchema,
  workerComputerUseApprovalResponseCommandSchema,
  workerComputerUsePreviewOpenCommandSchema,
  workerComputerUsePreviewStopCommandSchema,
  workerComputerUsePreviewRevokeCommandSchema,
} from "./worker-command-computer-use.js";

export const workerCommandSchema = z.discriminatedUnion("type", [
  workerComputerUseEffectsCommandSchema,
  workerComputerUseCommandSchema,
  workerComputerUseApprovalResponseCommandSchema,
  workerComputerUsePreviewOpenCommandSchema,
  workerComputerUsePreviewStopCommandSchema,
  workerComputerUsePreviewRevokeCommandSchema,
  ...workerCoreCommandSchemas,
  ...workerGithubProjectCommandSchemas,
  ...workerGitCommandSchemas,
  ...workerWorktreeCommandSchemas,
  ...workerSurfaceCommandSchemas,
  ...workerChatCommandSchemas,
  generateLabelCommandSchema,
  ...workerCantripOsCommandSchemas,
  ...workerCantripOsPowerCommandSchemas,
  ...workerCantripOsPackageCommandSchemas,
  ...workerCantripOsSystemCommandSchemas,
  ...workerCantripOsDesktopCommandSchemas,
  ...workerCantripOsBackupCommandSchemas,
  cantripOsRunDefinitionWorkerCommandSchema,
  ...workerCantripOsRunCommandSchemas,
]);

export type WorkerCommand = z.infer<typeof workerCommandSchema>;

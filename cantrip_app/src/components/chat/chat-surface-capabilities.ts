export interface ChatSurfaceCapabilities {
  context: "project" | "standalone";
  council?: true;
  modes: "agent-modes" | "default-only";
  inspect: boolean;
  linkedConsole: boolean;
  subagents: boolean;
  projectReferences: boolean;
  projectCommands: boolean;
  customizationInventory: boolean;
  scratchFiles: boolean;
  skillPicker: boolean;
}

export const IDE_CHAT_SURFACE_CAPABILITIES = {
  context: "project",
  modes: "agent-modes",
  inspect: true,
  linkedConsole: true,
  subagents: true,
  projectReferences: true,
  projectCommands: true,
  customizationInventory: true,
  scratchFiles: false,
  skillPicker: true,
} as const satisfies ChatSurfaceCapabilities;

export const STANDALONE_CHAT_SURFACE_CAPABILITIES = {
  context: "standalone",
  modes: "default-only",
  inspect: false,
  linkedConsole: false,
  subagents: false,
  projectReferences: false,
  projectCommands: false,
  customizationInventory: false,
  scratchFiles: true,
  skillPicker: false,
} as const satisfies ChatSurfaceCapabilities;

export const COUNCIL_CHAT_SURFACE_CAPABILITIES = {
  ...STANDALONE_CHAT_SURFACE_CAPABILITIES,
  council: true,
} as const satisfies ChatSurfaceCapabilities;

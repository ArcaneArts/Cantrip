import { describe, expect, it } from "vitest";

import {
  IDE_CHAT_SURFACE_CAPABILITIES,
  STANDALONE_CHAT_SURFACE_CAPABILITIES,
} from "./chat-surface-capabilities";

describe("chat surface capability profiles", () => {
  it("keeps the full project IDE composition", () => {
    expect(IDE_CHAT_SURFACE_CAPABILITIES).toMatchObject({
      context: "project",
      inspect: true,
      linkedConsole: true,
      modes: "agent-modes",
      projectCommands: true,
      subagents: true,
    });
  });

  it("keeps standalone Chat focused on conversation and scratch files", () => {
    expect(STANDALONE_CHAT_SURFACE_CAPABILITIES).toEqual({
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
    });
  });
});

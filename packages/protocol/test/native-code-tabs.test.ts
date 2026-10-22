import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { codeTabCreateSchema, workerCommandSchema } from "../src/index.js";

describe("native Code tab contracts", () => {
  it("creates native metadata without a workbench profile or runtime", () => {
    expect(codeTabCreateSchema.parse({})).toEqual({ title: "Code" });
  });
  it.each([
    { type: "code.probe" },
    {
      type: "code.open",
      sessionId: randomUUID(),
      codeTabId: randomUUID(),
      projectId: randomUUID(),
      worktreeId: randomUUID(),
      cwd: "/tmp/native-editor",
      profileId: "default",
      themeMode: "follow-cantrip",
      appearance: "dark",
      presentation: "workbench",
    },
    {
      type: "code.settings.workbench.open",
      sessionId: randomUUID(),
      profileId: "default",
      appearance: "dark",
    },
  ])(
    "rejects a formerly valid $type request instead of starting VS Code",
    (command) => {
      expect(workerCommandSchema.safeParse(command).success).toBe(false);
    },
  );
});

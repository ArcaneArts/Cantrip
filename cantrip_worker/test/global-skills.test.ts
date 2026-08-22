import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  mergeCodexSkillRoots,
  workerGlobalCodexSkillsRoot,
} from "../src/codex/global-skills.js";

describe("worker global Codex skills", () => {
  it("uses the worker user's legacy .codex skills directory by default", () => {
    expect(workerGlobalCodexSkillsRoot("/worker/home", {})).toBe(
      path.join("/worker/home", ".codex", "skills"),
    );
  });

  it("honors the worker's native CODEX_HOME before Cantrip isolates runtimes", () => {
    expect(
      workerGlobalCodexSkillsRoot("/worker/home", {
        CODEX_HOME: "/custom/codex-home",
      }),
    ).toBe(path.join("/custom/codex-home", "skills"));
  });

  it("keeps global roots while deduplicating project roots", () => {
    expect(
      mergeCodexSkillRoots(
        ["/worker/home/.codex/skills"],
        ["/project/shared-skills", "/project/shared-skills"],
      ),
    ).toEqual([
      path.resolve("/worker/home/.codex/skills"),
      path.resolve("/project/shared-skills"),
    ]);
  });
});

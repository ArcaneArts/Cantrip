import { describe, expect, it } from "vitest";

import { displayCommand } from "./command-display";

describe("command display", () => {
  it("unwraps login-shell commands without changing their source value", () => {
    const command =
      '/bin/zsh -lc "grep -rn \\"NoiseStyle\\\\|NoiseType\\" \\"/tmp/project\\""';

    expect(displayCommand(command)).toBe(
      'grep -rn "NoiseStyle\\|NoiseType" "/tmp/project"',
    );
    expect(command).toBe(
      '/bin/zsh -lc "grep -rn \\"NoiseStyle\\\\|NoiseType\\" \\"/tmp/project\\""',
    );
  });

  it("supports single-quoted and unquoted shell payloads", () => {
    expect(displayCommand("/usr/bin/bash -lc 'pnpm check'")).toBe("pnpm check");
    expect(displayCommand("sh -lc git status --short")).toBe(
      "git status --short",
    );
  });

  it("leaves commands that are not login-shell wrappers unchanged", () => {
    expect(displayCommand("/bin/zsh -c 'pnpm check'")).toBe(
      "/bin/zsh -c 'pnpm check'",
    );
    expect(displayCommand("printf '/bin/zsh -lc test'")).toBe(
      "printf '/bin/zsh -lc test'",
    );
  });
});

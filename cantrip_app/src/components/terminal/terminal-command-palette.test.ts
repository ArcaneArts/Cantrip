import type { ScriptCommand } from "@cantrip/protocol";
import { describe, expect, it, vi } from "vitest";

import {
  ensureTerminalCommandSelectionVisible,
  filterTerminalScriptCommands,
  moveTerminalCommandSelection,
  terminalCommandInput,
} from "./terminal-command-palette";

const commands: ScriptCommand[] = [
  {
    id: "package:package.json:dev",
    kind: "package",
    name: "dev",
    command: "pnpm run dev",
    description: "Start the Vite development server.",
    source: "package.json",
  },
  {
    id: "cargo:Cargo.toml:test",
    kind: "cargo",
    name: "test",
    command: "cargo test",
    description: "Run the Cargo test suite.",
    source: "Cargo.toml",
  },
  {
    id: "make:Makefile:release",
    kind: "make",
    name: "release",
    command: "make release",
    description: "Package the application.",
    source: "Makefile",
  },
];

describe("terminal command palette", () => {
  it("filters names, invocations, sources, and descriptions", () => {
    expect(filterTerminalScriptCommands("dev", commands)[0]?.name).toBe("dev");
    expect(filterTerminalScriptCommands("cargo", commands)[0]?.name).toBe(
      "test",
    );
    expect(filterTerminalScriptCommands("makefile", commands)[0]?.name).toBe(
      "release",
    );
    expect(filterTerminalScriptCommands("package", commands)[0]?.name).toBe(
      "dev",
    );
    expect(filterTerminalScriptCommands("application", commands)[0]?.name).toBe(
      "release",
    );
  });

  it("wraps keyboard selection and submits the chosen command", () => {
    expect(moveTerminalCommandSelection(0, -1, commands.length)).toBe(2);
    expect(moveTerminalCommandSelection(2, 1, commands.length)).toBe(0);
    expect(moveTerminalCommandSelection(0, 1, 0)).toBe(0);
    expect(terminalCommandInput(commands[0]!)).toBe("pnpm run dev\r");
  });

  it("auto-scrolls keyboard selection without chasing pointer hover", () => {
    const scrollIntoView = vi.fn();
    const element = { scrollIntoView };

    ensureTerminalCommandSelectionVisible(element, "pointer");
    ensureTerminalCommandSelectionVisible(element, "reset");
    expect(scrollIntoView).not.toHaveBeenCalled();

    ensureTerminalCommandSelectionVisible(element, "keyboard");
    expect(scrollIntoView).toHaveBeenCalledOnce();
    expect(scrollIntoView).toHaveBeenCalledWith({ block: "nearest" });
  });
});

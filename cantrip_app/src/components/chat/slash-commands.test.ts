import { describe, expect, it } from "vitest";

import {
  filterSlashCommands,
  slashCommandQuery,
  SLASH_COMMANDS,
} from "./slash-commands";

describe("slash commands", () => {
  it("opens only for a command token at the start of an otherwise empty draft", () => {
    expect(slashCommandQuery("/")).toBe("");
    expect(slashCommandQuery("/comp")).toBe("comp");
    expect(slashCommandQuery("hello /comp")).toBeNull();
    expect(slashCommandQuery("/compact now")).toBeNull();
  });

  it("ranks prefix matches first", () => {
    expect(filterSlashCommands("comp")[0]?.invocation).toBe("/compact");
  });

  it("lists the core chat workflow commands", () => {
    const commands = filterSlashCommands("").map(
      ({ invocation }) => invocation,
    );
    expect(commands).toEqual(
      expect.arrayContaining(["/compact", "/fork", "/new", "/review"]),
    );
    expect(SLASH_COMMANDS.length).toBeGreaterThanOrEqual(10);
  });
});

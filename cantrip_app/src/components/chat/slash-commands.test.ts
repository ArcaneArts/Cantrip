import { describe, expect, it } from "vitest";

import {
  filterSlashCommands,
  settingsSlashCommand,
  slashCommandQuery,
  SLASH_COMMANDS,
} from "./slash-commands";

describe("slash commands", () => {
  it("opens only for a command token at the start of an otherwise empty draft", () => {
    expect(slashCommandQuery("/")).toBe("");
    expect(slashCommandQuery("/comp")).toBe("comp");
    expect(slashCommandQuery("/project/release")).toBe("project/release");
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
      expect.arrayContaining([
        "/compact",
        "/model",
        "/permissions",
        "/fork",
        "/goal",
        "/new",
        "/pause",
        "/plan",
        "/review",
      ]),
    );
    expect(SLASH_COMMANDS.length).toBeGreaterThanOrEqual(10);
  });
});

describe("settings command parsing", () => {
  it.each(["model", "permissions"])(
    "recognizes /%s with whitespace and case variants",
    (name) => {
      expect(settingsSlashCommand(` /${name.toUpperCase()} \n`)).toEqual({
        name,
        arguments: "",
      });
      expect(settingsSlashCommand(`/${name} choice\nmore`)).toEqual({
        name,
        arguments: "choice\nmore",
      });
    },
  );

  it.each([
    "/models",
    "/permissions-extra",
    "explain /model",
    "/model/other",
    "/review",
  ])("leaves %s to normal command/prompt handling", (draft) => {
    expect(settingsSlashCommand(draft)).toBeNull();
  });
});

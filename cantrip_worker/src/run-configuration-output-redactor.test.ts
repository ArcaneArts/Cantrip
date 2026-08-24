import { describe, expect, it } from "vitest";

import { RunConfigurationOutputRedactor } from "./run-configuration-output-redactor.js";

describe("RunConfigurationOutputRedactor", () => {
  it("passes ordinary output through without configured secrets", () => {
    const redactor = new RunConfigurationOutputRedactor([]);

    expect(redactor.write("ordinary output")).toBe("ordinary output");
    expect(redactor.flush()).toBe("");
  });

  it("redacts complete secrets and values split across arbitrary chunks", () => {
    const secret = "opened-secret-revision-1";
    const redactor = new RunConfigurationOutputRedactor([secret]);

    expect(redactor.write("before opened-secret-")).toBe("before ");
    expect(redactor.write("revision-")).toBe("");
    expect(redactor.write("1 after")).toBe("•••• after");
    expect(redactor.flush()).toBe("");
  });

  it("matches complete redaction at every chunk boundary", () => {
    const secrets = ["first-private-value", "second-private-value"];
    const source = `head ${secrets[0]} middle ${secrets[1]} tail`;
    const expected = new RunConfigurationOutputRedactor(secrets).redactComplete(
      source,
    );

    for (let split = 0; split <= source.length; split += 1) {
      const redactor = new RunConfigurationOutputRedactor(secrets);
      expect(
        `${redactor.write(source.slice(0, split))}${redactor.write(source.slice(split))}${redactor.flush()}`,
      ).toBe(expected);
    }

    const characterRedactor = new RunConfigurationOutputRedactor(secrets);
    expect(
      `${[...source].map((character) => characterRedactor.write(character)).join("")}${characterRedactor.flush()}`,
    ).toBe(expected);
  });

  it("redacts complete prefix values without exposing a longer value", () => {
    const redactor = new RunConfigurationOutputRedactor(["token", "token-2"]);

    const output = [
      redactor.write("token"),
      redactor.write(" token-"),
      redactor.write("2"),
      redactor.flush(),
    ].join("");
    expect(output).toBe("•••• ••••-2");
    expect(output).not.toContain("token");
    expect(output).not.toContain("token-2");
  });

  it("flushes a trailing partial value only after the stream ends", () => {
    const redactor = new RunConfigurationOutputRedactor(["sensitive"]);

    expect(redactor.write("safe sensi")).toBe("safe ");
    expect(redactor.flush()).toBe("sensi");
  });

  it("uses an empty marker when a secret contains the visible marker character", () => {
    const redactor = new RunConfigurationOutputRedactor(["secret•value"]);

    expect(redactor.write("before secret•value after")).toBe("before  after");
  });
});

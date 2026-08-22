import { describe, expect, it } from "vitest";

import {
  cantripAgentOperationNameSchema,
  cantripCliCommandNameSchema,
  workerCommandSchema,
} from "./index.js";
import {
  RUN_CONFIGURATION_CANONICAL_PATH,
  runConfigurationInspectionSchema,
} from "./run-configurations.js";

describe("runConfigurationInspectionSchema", () => {
  it("bounds and normalizes the unconfigured state", () => {
    expect(
      runConfigurationInspectionSchema.parse({
        platform: "linux",
        canonical: {
          relativePath: RUN_CONFIGURATION_CANONICAL_PATH,
          sourceControlState: "absent",
        },
        configured: false,
        valid: true,
        configurations: [],
        diagnostics: [],
      }),
    ).toMatchObject({ configured: false, valid: true });
  });

  it("rejects action commands containing NUL", () => {
    expect(() =>
      runConfigurationInspectionSchema.parse({
        platform: "linux",
        canonical: {
          relativePath: RUN_CONFIGURATION_CANONICAL_PATH,
          sourceControlState: "untracked",
        },
        configured: true,
        valid: true,
        configurations: [
          {
            relativePath: RUN_CONFIGURATION_CANONICAL_PATH,
            revision: "a".repeat(64),
            version: 1,
            name: "Example",
            sourceControlState: "untracked",
            setup: null,
            actions: [
              {
                id: "b".repeat(64),
                name: "Run",
                icon: "run",
                command: "echo before\0after",
                platform: null,
                configurationPath: RUN_CONFIGURATION_CANONICAL_PATH,
                sourceIndex: 0,
              },
            ],
            diagnostics: [],
          },
        ],
        diagnostics: [],
      }),
    ).toThrow();
  });

  it("registers the discovery operations without broad worker arguments", () => {
    expect(cantripAgentOperationNameSchema.parse("run-config.list")).toBe(
      "run-config.list",
    );
    expect(cantripAgentOperationNameSchema.parse("run-config.read")).toBe(
      "run-config.read",
    );
    expect(cantripCliCommandNameSchema.parse("run.config-path")).toBe(
      "run.config-path",
    );
    expect(
      workerCommandSchema.parse({
        type: "project.run-configurations.inspect",
        sourcePath: "/project/source",
      }),
    ).toEqual({
      type: "project.run-configurations.inspect",
      sourcePath: "/project/source",
    });
    expect(
      workerCommandSchema.safeParse({
        type: "project.run-configurations.inspect",
        sourcePath: "/project/source",
        worktreePath: "/untrusted/override",
      }).success,
    ).toBe(false);
  });
});

import { describe, expect, it } from "vitest";

import {
  CANTRIP_MCP_OPERATIONS,
  CANTRIP_MCP_TOOL_NAMES,
  cantripAgentOperationNameSchema,
  cantripCliCommandNameSchema,
  workerCommandSchema,
  workerNotificationSchema,
} from "./index.js";

const operationId = "11111111-1111-4111-8111-111111111111";
const projectId = "22222222-2222-4222-8222-222222222222";

describe("Run configuration cutover", () => {
  it("exposes only the stable-ID MCP and CLI surface", () => {
    for (const operation of [
      "run-configuration.list",
      "run-configuration.get",
      "run-configuration.detect",
      "run-configuration.create",
      "run-configuration.update",
      "run-configuration.delete",
      "run-configuration.start",
      "run-configuration.restart",
      "run-configuration.stop",
      "run-configuration.status",
      "run-configuration.read-output",
      "run-configuration.secret-set",
    ]) {
      expect(cantripAgentOperationNameSchema.parse(operation)).toBe(operation);
      expect(CANTRIP_MCP_OPERATIONS).toContain(operation);
    }
    for (const command of [
      "run.list",
      "run.show",
      "run.detect",
      "run.create",
      "run.update",
      "run.delete",
      "run.start",
      "run.restart",
      "run.status",
      "run.logs",
      "run.stop",
      "run.secret-set",
    ]) {
      expect(cantripCliCommandNameSchema.parse(command)).toBe(command);
    }
    expect(CANTRIP_MCP_TOOL_NAMES).toEqual(
      expect.arrayContaining([
        "run_configuration_list",
        "run_configuration_get",
        "run_configuration_detect",
        "run_configuration_create",
        "run_configuration_update",
        "run_configuration_delete",
        "run_configuration_start",
        "run_configuration_restart",
        "run_configuration_stop",
        "run_configuration_status",
        "run_configuration_read_output",
        "run_configuration_secret_set",
      ]),
    );
  });

  it("rejects every removed action and setup operation", () => {
    for (const operation of [
      "run-config.list",
      "run-config.read",
      "run-config.schema",
      "run-config.action-add",
      "run-config.authoring",
      "run-config.write",
      "run.start",
      "run.open",
      "run.setup-status",
      "run.setup-retry",
      "run.status",
      "run.read",
      "run.stop",
    ]) {
      expect(cantripAgentOperationNameSchema.safeParse(operation).success).toBe(
        false,
      );
    }
  });

  it("accepts replacement worker commands and rejects removed commands", () => {
    expect(
      workerCommandSchema.parse({
        type: "project.run-configuration-definitions.list",
        operationId,
        projectId,
        sourcePath: "/project/source",
      }),
    ).toMatchObject({
      type: "project.run-configuration-definitions.list",
      projectId,
    });
    for (const type of [
      "project.run-configurations.metadata",
      "project.run-configurations.inspect",
      "project.run-configurations.read-authoring",
      "project.run-configurations.write",
      "project.run-setup.start",
      "project.run-setup.status",
      "project.run.start",
      "project.run.status",
      "project.run.logs",
      "project.run.stop",
      "project.run.reconcile",
    ]) {
      expect(workerCommandSchema.safeParse({ type }).success).toBe(false);
    }
    expect(
      workerNotificationSchema.safeParse({
        type: "project.run.state.observed",
      }).success,
    ).toBe(false);
  });
});

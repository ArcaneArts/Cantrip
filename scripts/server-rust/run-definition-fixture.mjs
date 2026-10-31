import { runConfigurationFileSchema } from "../../packages/protocol/dist/run-configuration-definitions.js";
export function runDefinition(command) {
  return {
    operation: "get",
    operationId: command.operationId,
    projectId: command.projectId,
    result: {
      found: true,
      entry: {
        relativePath: `.cantrip/run-configurations/${command.configurationId}.json`,
        revision: "a".repeat(64),
        id: command.configurationId,
        status: "ready",
        document: runConfigurationFileSchema.parse({
          schema: "cantrip.run-configuration",
          version: 1,
          id: command.configurationId,
          name: "Lifecycle acceptance",
          provider: "shell",
          target: { kind: "command", command: "echo acceptance" },
          environment: {
            secrets: [
              { name: "API_KEY", secret: "run/api" },
              { name: "MISSING", secret: "run/missing" },
            ],
          },
          platformOverrides: {
            linux: {
              environment: {
                secrets: [
                  { name: "PLATFORM_KEY", secret: "run/platform" },
                  { name: "DUPLICATE", secret: "run/api" },
                ],
              },
            },
          },
        }),
        diagnostics: [],
      },
    },
    codexEnvironment: {
      enabled: false,
      configured: false,
      valid: true,
      revision: null,
      hasSetup: false,
      diagnostics: [],
    },
    secretReferences: [],
  };
}

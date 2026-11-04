import { scopedClientStorageKey } from "./client-session";
import { createContext, useContext, useMemo, type ReactNode } from "react";
import type {
  CantripOsSourceBindingSummary,
  CantripOsRunDefinitionRequest,
} from "@cantrip/protocol";
import * as host from "./run-configuration-api";
import { executeCantripOsRunDefinition } from "./api/cantrip-os";
import {
  runConfigurationCapabilitiesResponseSchema,
  runConfigurationDetectResponseSchema,
  runConfigurationFlutterDevicesResponseSchema,
  runConfigurationGetResponseSchema,
  runConfigurationListResponseSchema,
  runConfigurationPathsResponseSchema,
  runConfigurationValidateResponseSchema,
  runConfigurationWriteResponseSchema,
} from "@cantrip/protocol/run-configuration-operations";

export function linuxRunDefinitionApi(binding: CantripOsSourceBindingSummary) {
  const admissions = new Map<string, string>();
  const call = async (request: CantripOsRunDefinitionRequest) => {
    let storedKey: string | null = null;
    if (request.type.endsWith(".write")) {
      const { operationId, ...intent } = request;
      const bytes = await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(JSON.stringify(intent)),
      );
      const fingerprint = Array.from(new Uint8Array(bytes), (value) =>
        value.toString(16).padStart(2, "0"),
      ).join("");
      storedKey = scopedClientStorageKey(
        `cantrip:linux-run-write:${binding.id}:${binding.bindingGeneration}:${binding.provisionedAttachmentGeneration}:${binding.provisionedRuntimeGeneration}:${fingerprint}`,
      );
      let admitted = admissions.get(storedKey) ?? operationId;
      if (typeof window !== "undefined")
        admitted = window.localStorage.getItem(storedKey) ?? admitted;
      admissions.set(storedKey, admitted);
      if (typeof window !== "undefined")
        window.localStorage.setItem(storedKey, admitted);
      request = { ...request, operationId: admitted };
    }
    const result = (await executeCantripOsRunDefinition(binding, request))
      .result;
    if (storedKey) {
      admissions.delete(storedKey);
      if (typeof window !== "undefined")
        window.localStorage.removeItem(storedKey);
    }
    return result;
  };
  const api = {
    ...host,
    listRunConfigurations: async (
      projectId: string,
      operationId = crypto.randomUUID(),
    ) => {
      const response = runConfigurationListResponseSchema.parse(
        await call({
          type: "project.run-configuration-definitions.list",
          projectId,
          operationId,
        }),
      );
      return { ...response.inventory, validations: response.validations };
    },
    getRunConfiguration: async (
      projectId: string,
      configurationId: string,
      operationId = crypto.randomUUID(),
    ) =>
      runConfigurationGetResponseSchema.parse(
        await call({
          type: "project.run-configuration-definitions.get",
          projectId,
          configurationId,
          operationId,
        }),
      ).result,
    getRunConfigurationCapabilities: async (
      projectId: string,
      operationId = crypto.randomUUID(),
    ) =>
      runConfigurationCapabilitiesResponseSchema.parse(
        await call({
          type: "project.run-configuration-definitions.capabilities",
          projectId,
          operationId,
        }),
      ).capabilities,
    detectRunConfigurations: async (
      projectId: string,
      provider: Parameters<typeof host.detectRunConfigurations>[1] = null,
      operationId = crypto.randomUUID(),
    ) => {
      const response = runConfigurationDetectResponseSchema.parse(
        await call({
          type: "project.run-configuration-definitions.detect",
          projectId,
          operationId,
          providerKind: provider,
        }),
      );
      return {
        candidates: response.candidates,
        diagnostics: response.diagnostics,
      };
    },
    discoverRunConfigurationPaths: async (
      projectId: string,
      purpose: Parameters<typeof host.discoverRunConfigurationPaths>[1],
      query = "",
      operationId = crypto.randomUUID(),
    ) => {
      const response = runConfigurationPathsResponseSchema.parse(
        await call({
          type: "project.run-configuration-definitions.paths",
          projectId,
          purpose,
          query,
          operationId,
        }),
      );
      return {
        suggestions: response.suggestions,
        truncated: response.truncated,
      };
    },
    inspectFlutterRunConfigurationDevices: async (
      projectId: string,
      document: Parameters<
        typeof host.inspectFlutterRunConfigurationDevices
      >[1],
      operationId = crypto.randomUUID(),
    ) => {
      const response = runConfigurationFlutterDevicesResponseSchema.parse(
        await call({
          type: "project.run-configuration-definitions.flutter-devices",
          projectId,
          document,
          operationId,
        }),
      );
      return {
        devices: response.devices,
        diagnostics: response.diagnostics,
        platform: response.platform,
      };
    },
    validateRunConfiguration: async (
      projectId: string,
      document: Parameters<typeof host.validateRunConfiguration>[1],
      operationId = crypto.randomUUID(),
    ) =>
      runConfigurationValidateResponseSchema.parse(
        await call({
          type: "project.run-configuration-definitions.validate",
          projectId,
          document,
          operationId,
        }),
      ).validation,
    saveRunConfiguration: async (
      projectId: string,
      request: Parameters<typeof host.saveRunConfiguration>[1],
      operationId = crypto.randomUUID(),
    ) =>
      runConfigurationWriteResponseSchema.parse(
        await call({
          type: "project.run-configuration-definitions.write",
          projectId,
          request,
          operationId,
        }),
      ).result,
    deleteRunConfiguration: async (): Promise<never> => {
      throw new Error(
        "Delete is not available for Linux Run configurations yet.",
      );
    },
  };
  return api;
}

const Context = createContext<typeof host>(host);
const ScopeContext = createContext("host");
export function RunDefinitionSourceProvider({
  binding,
  children,
}: {
  binding?: CantripOsSourceBindingSummary;
  children: ReactNode;
}) {
  const key = binding
    ? JSON.stringify([
        binding.id,
        binding.bindingGeneration,
        binding.provisionedAttachmentGeneration,
        binding.provisionedRuntimeGeneration,
      ])
    : "host";
  // A refetch must retain uncertain write admission IDs for the same epoch.
  const api = useMemo(
    () => (binding ? linuxRunDefinitionApi(binding) : host),
    [key],
  );
  return (
    <ScopeContext.Provider value={key}>
      <Context.Provider value={api}>{children}</Context.Provider>
    </ScopeContext.Provider>
  );
}
export const useRunDefinitionApi = () => useContext(Context);
export const useRunDefinitionScope = () => useContext(ScopeContext);

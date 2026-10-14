import {
  projectTokenUsageSchema,
  providerTelemetryExportSchema,
  providerTelemetryDeleteResultSchema,
} from "@cantrip/protocol";
import { request } from "@/lib/api-client";
import type {
  ModelProviderSummary,
  ModelProfileSummary,
} from "@cantrip/protocol";
import { openProviderTelemetryWireAnalytics } from "@/lib/provider-telemetry";

export async function getProjectTokenUsage(projectId: string) {
  return projectTokenUsageSchema.parse(
    await request(`/api/projects/${encodeURIComponent(projectId)}/token-usage`),
  );
}

export async function getProviderTelemetryAnalytics(input: {
  provider: ModelProviderSummary;
  models: readonly ModelProfileSummary[];
  providerAccountId?: string;
  modelId?: string;
  reasoningEffort?: string;
  projectId?: string;
  days?: number;
}) {
  const query = new URLSearchParams();
  query.set("providerId", input.provider.id);
  for (const [key, value] of Object.entries({
    providerAccountId: input.providerAccountId,
    modelId: input.modelId,
    reasoningEffort: input.reasoningEffort,
    projectId: input.projectId,
    days: input.days,
  })) {
    if (value !== undefined && value !== "") query.set(key, String(value));
  }
  return openProviderTelemetryWireAnalytics(
    await request(`/api/analytics/provider-telemetry?${query.toString()}`),
    input.provider,
    input.models,
  );
}

export async function getProviderTelemetryExport(providerId: string) {
  return providerTelemetryExportSchema.parse(
    await request(
      `/api/analytics/provider-telemetry/${encodeURIComponent(providerId)}/export`,
    ),
  );
}

export async function deleteProviderTelemetryHistory(providerId: string) {
  return providerTelemetryDeleteResultSchema.parse(
    await request(
      `/api/analytics/provider-telemetry/${encodeURIComponent(providerId)}`,
      { method: "DELETE" },
    ),
  );
}

import type { RunConfigurationFile } from "@cantrip/protocol/run-configuration-definitions";

export function runConfigurationSecretReferences(
  document: RunConfigurationFile,
): string[] {
  const references = new Set(
    document.environment.secrets.map(({ secret }) => secret),
  );
  const overrides = Object.values(document.platformOverrides) as Array<{
    environment?: { secrets?: Array<{ secret: string }> };
  }>;
  for (const override of overrides) {
    for (const secret of override.environment?.secrets ?? []) {
      references.add(secret.secret);
    }
  }
  return [...references].sort((left, right) => left.localeCompare(right));
}

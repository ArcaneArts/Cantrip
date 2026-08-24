export function runConfigurationEnvironmentNameIsReserved(
  name: string,
): boolean {
  const upper = name.toUpperCase();
  return (
    upper.startsWith("CANTRIP_") ||
    upper.startsWith("_CANTRIP_") ||
    upper === "CODEX_WORKTREE_PATH"
  );
}

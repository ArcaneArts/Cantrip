export function explorerSurfaceSelectedPath({
  openFilesExternally,
  persistedPath,
  transientPath,
}: {
  openFilesExternally: boolean;
  persistedPath: string | null;
  transientPath?: string;
}): string | null {
  return transientPath ?? (openFilesExternally ? null : persistedPath);
}

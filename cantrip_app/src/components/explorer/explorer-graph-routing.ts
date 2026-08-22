import type { ExplorerEntry, ProjectCapabilities } from "@cantrip/protocol";

export function explorerRepositoryGraphAvailable(
  capabilities: Pick<ProjectCapabilities, "git"> | null | undefined,
): boolean {
  return capabilities?.git === true;
}

export function explorerFileEntryForGraphPath(path: string): ExplorerEntry {
  return {
    kind: "file",
    markdown: /\.mdx?$/iu.test(path),
    modifiedAt: new Date(0).toISOString(),
    name: path.split("/").at(-1) ?? path,
    path,
    size: null,
    symbolicLink: false,
    viewable: true,
  };
}

export function explorerGraphRootForEntry(
  entry: Pick<ExplorerEntry, "kind" | "path">,
): string | null {
  if (entry.kind === "directory") return entry.path || null;
  const separator = entry.path.lastIndexOf("/");
  return separator < 0 ? null : entry.path.slice(0, separator) || null;
}

export function explorerExpandedPathsForReveal(path: string): string[] {
  const segments = path.split("/").filter(Boolean);
  const expanded: string[] = [];
  for (let index = 1; index < segments.length; index += 1) {
    expanded.push(segments.slice(0, index).join("/"));
  }
  return expanded;
}

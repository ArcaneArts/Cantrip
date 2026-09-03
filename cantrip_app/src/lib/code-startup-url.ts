import type { CodeRuntimeStatus } from "@cantrip/protocol";

function localFileUri(raw: string, label: string): URL {
  const value = new URL(raw);
  if (value.protocol !== "file:" || value.search !== "" || value.hash !== "") {
    throw new Error(`Cantrip Code supplied an invalid ${label} URI.`);
  }
  return value;
}

function localPath(value: URL): string {
  const pathname = decodeURIComponent(value.pathname);
  return value.host ? `//${value.host}${pathname}` : pathname;
}

export function configureCodeStartupUrl(
  url: URL,
  runtime: Pick<CodeRuntimeStatus, "initialFileUri" | "workspaceUri">,
  remoteAuthority: string,
): URL {
  if (runtime.workspaceUri) {
    url.searchParams.set(
      "workspace",
      localPath(localFileUri(runtime.workspaceUri, "workspace")),
    );
  }
  if (runtime.initialFileUri) {
    const initialFile = localFileUri(runtime.initialFileUri, "initial file");
    const remotePath = initialFile.host
      ? `//${initialFile.host}${initialFile.pathname}`
      : initialFile.pathname;
    const remoteFile = new URL(
      `vscode-remote://${remoteAuthority}${remotePath}`,
    );
    url.searchParams.set(
      "payload",
      JSON.stringify([["openFile", remoteFile.href]]),
    );
  }
  return url;
}

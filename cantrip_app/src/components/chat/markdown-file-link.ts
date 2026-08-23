import { defaultUrlTransform } from "react-markdown";

const FILE_LINK_PREFIX = "#cantrip-file=";
const WINDOWS_ABSOLUTE_PATH = /^[a-z]:[\\/]/i;
const URL_SCHEME = /^[a-z][a-z\d+.-]*:/i;

function decodePath(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function fileUrlPath(value: string): string | null {
  if (!/^file:/i.test(value)) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "file:") return null;
    const pathname = decodePath(url.pathname);
    if (url.hostname && url.hostname !== "localhost") {
      return `//${url.hostname}${pathname}`;
    }
    return /^\/[a-z]:\//i.test(pathname) ? pathname.slice(1) : pathname;
  } catch {
    return null;
  }
}

export function markdownFileReference(value: string): string | null {
  const candidate = value.trim();
  if (!candidate) return null;
  const decodedCandidate = decodePath(candidate);

  const filePath = fileUrlPath(decodedCandidate);
  if (filePath) return filePath;

  if (WINDOWS_ABSOLUTE_PATH.test(decodedCandidate)) return decodedCandidate;
  if (
    decodedCandidate.startsWith("#") ||
    decodedCandidate.startsWith("?") ||
    decodedCandidate.startsWith("//") ||
    URL_SCHEME.test(decodedCandidate)
  ) {
    return null;
  }
  return decodedCandidate;
}

export function markdownFileLinkUrlTransform(value: string): string {
  const path = markdownFileReference(value);
  return path
    ? `${FILE_LINK_PREFIX}${encodeURIComponent(path)}`
    : defaultUrlTransform(value);
}

export function markdownFilePathFromHref(
  href: string | undefined,
): string | null {
  if (!href?.startsWith(FILE_LINK_PREFIX)) return null;
  const encodedPath = href.slice(FILE_LINK_PREFIX.length);
  if (!encodedPath) return null;
  try {
    return decodeURIComponent(encodedPath);
  } catch {
    return null;
  }
}

function normalizedPath(value: string): string {
  return value.replaceAll("\\", "/").replace(/\/+$/, "");
}

function normalizedRelativePath(value: string): string | null {
  const segments: string[] = [];
  for (const segment of value.split("/")) {
    if (!segment || segment === ".") continue;
    if (segment === "..") {
      if (segments.length === 0) return null;
      segments.pop();
      continue;
    }
    segments.push(segment);
  }
  const path = segments.join("/");
  return path || null;
}

function removeSourceLocation(value: string): string {
  return value.replace(/#L\d+(?:C\d+)?$/i, "").replace(/:\d+(?::\d+)?$/, "");
}

export function projectFilePath(
  reference: string,
  worktreePath: string,
): string | null {
  const parsedReference = markdownFileReference(reference);
  if (!parsedReference) return null;

  const root = normalizedPath(worktreePath);
  const candidate = removeSourceLocation(normalizedPath(parsedReference));
  const absolute =
    candidate.startsWith("/") || WINDOWS_ABSOLUTE_PATH.test(candidate);

  if (!absolute) return normalizedRelativePath(candidate);

  const windowsPath = WINDOWS_ABSOLUTE_PATH.test(root);
  const comparableRoot = windowsPath ? root.toLowerCase() : root;
  const comparableCandidate = windowsPath ? candidate.toLowerCase() : candidate;
  if (!comparableCandidate.startsWith(`${comparableRoot}/`)) return null;

  return normalizedRelativePath(candidate.slice(root.length + 1));
}

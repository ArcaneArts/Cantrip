import { CantripOsPlacementError } from "./cantrip-os-error.js";

/** Linux path semantics are independent of the Server's host platform. The
 * native executor later canonicalizes this actual directory; symlink redirection
 * cannot change a binding's admitted path. */
export function existingLinuxSourcePath(home: string, relative: string) {
  if (!relative || relative.startsWith("/") || relative.includes("\0"))
    throw new CantripOsPlacementError(
      "Choose a path relative to the Linux workspace home.",
    );
  const parts: string[] = [];
  for (const part of relative.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..")
      throw new CantripOsPlacementError(
        "Parent traversal is not allowed in a source path. Choose its direct home-relative path.",
      );
    parts.push(part);
  }
  return (
    home.replace(/\/+$/u, "") + (parts.length ? `/${parts.join("/")}` : "")
  );
}

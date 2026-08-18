export type ProjectRemovalAction = "unlink" | "delete" | "confirm-delete";

export function projectRemovalAction(
  deleteLocalFiles: boolean,
  managedFolder: boolean,
): ProjectRemovalAction {
  if (!deleteLocalFiles) return "unlink";
  return managedFolder ? "confirm-delete" : "delete";
}

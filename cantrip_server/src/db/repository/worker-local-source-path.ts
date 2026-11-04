/** Legacy projections must never turn a guest-only address into a worker cwd. */
export function requireWorkerLocalPath(path: string | null): string {
  if (path === null)
    throw new Error("This checkout requires a CantripOS execution target.");
  return path;
}

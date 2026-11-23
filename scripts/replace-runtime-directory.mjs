import { renameSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";

export async function replaceRuntimeDirectory(
  destination,
  stagePrefix,
  assemble,
) {
  const parent = path.dirname(destination);
  await mkdir(parent, { recursive: true });
  const stage = await mkdtemp(path.join(parent, stagePrefix));
  const candidate = path.join(stage, "runtime");
  const previous = path.join(stage, "previous");
  let removeStage = true;
  try {
    await mkdir(candidate);
    await assemble(candidate);

    // Publish or roll back without yielding between the two renames.
    let hadPrevious = true;
    try {
      renameSync(destination, previous);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      hadPrevious = false;
    }
    try {
      renameSync(candidate, destination);
    } catch (error) {
      if (hadPrevious) {
        try {
          renameSync(previous, destination);
        } catch (restoreError) {
          removeStage = false;
          throw new AggregateError(
            [error, restoreError],
            `Could not publish ${destination}. The previous runtime is at ${previous}.`,
          );
        }
      }
      throw error;
    }
  } finally {
    if (removeStage) await rm(stage, { force: true, recursive: true });
  }
}

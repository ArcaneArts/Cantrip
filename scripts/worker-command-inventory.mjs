import { tsImport } from "tsx/esm/api";

// Read the source schema, not generated dist files or a parallel list of
// imported declarations. The discriminated union is the worker's contract.
export async function readWorkerCommandTypes() {
  const { workerCommandSchema } = await tsImport(
    "../packages/protocol/src/worker-commands.ts",
    import.meta.url,
  );
  return workerCommandSchema.options.map((schema) => {
    const type = schema.shape.type.value;
    if (typeof type !== "string") {
      throw new Error("Worker command discriminator must be a string literal.");
    }
    return type;
  });
}

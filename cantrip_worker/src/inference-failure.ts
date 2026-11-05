import {
  inferenceFailureEvidenceSchema,
  type InferenceFailureEvidence,
} from "@cantrip/protocol";

// Keep metadata through redaction without copying prompts, stacks, or causes
// into the worker response. Entries have each execution carrier's GC lifetime.
const failures = new WeakMap<Error, InferenceFailureEvidence>();
const originals = new WeakMap<Error, unknown>();

export function inferenceFailure(
  error: unknown,
): InferenceFailureEvidence | undefined {
  return error instanceof Error ? failures.get(error) : undefined;
}

export function recordInferenceFailure(
  error: unknown,
  evidence: InferenceFailureEvidence,
): Error {
  const parsed = inferenceFailureEvidenceSchema.safeParse(evidence);
  const original = sourceInferenceFailure(error);
  const scoped = new Error(
    original instanceof Error ? original.message : String(original),
  );
  if (original instanceof Error) scoped.name = original.name;
  if (original && typeof original === "object" && "code" in original)
    Object.defineProperty(scoped, "code", {
      value: original.code,
      enumerable: true,
    });
  // Startup promises can reject several calls with the same Error instance.
  // Give each execution its own carrier; never overwrite another call's proof.
  originals.set(scoped, original);
  if (parsed.success) failures.set(scoped, parsed.data);
  return scoped;
}

export function sourceInferenceFailure(error: unknown): unknown {
  return error instanceof Error && originals.has(error)
    ? originals.get(error)
    : error;
}

export function copyInferenceFailure(source: unknown, target: Error): Error {
  const evidence = inferenceFailure(source);
  if (evidence) failures.set(target, evidence);
  return target;
}

export function clearInferenceFailure(error: unknown): void {
  if (error instanceof Error) failures.delete(error);
}

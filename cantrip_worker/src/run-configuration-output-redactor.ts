const REDACTION_MARKER = "••••";

function normalizedSecrets(values: readonly string[]): string[] {
  return [...new Set(values.filter((value) => value.length > 0))].sort(
    (left, right) => right.length - left.length,
  );
}

export class RunConfigurationOutputRedactor {
  readonly #marker: string;
  readonly #secretsByFirstCharacter = new Map<string, string[]>();
  #pending = "";

  constructor(values: readonly string[]) {
    const secrets = normalizedSecrets(values);
    this.#marker = secrets.some((secret) => secret.includes("•"))
      ? ""
      : REDACTION_MARKER;
    for (const secret of secrets) {
      const first = secret.slice(0, 1);
      const current = this.#secretsByFirstCharacter.get(first) ?? [];
      current.push(secret);
      this.#secretsByFirstCharacter.set(first, current);
    }
  }

  write(data: string): string {
    const transformed = this.#transform(`${this.#pending}${data}`, false);
    this.#pending = transformed.pending;
    return transformed.output;
  }

  flush(): string {
    const transformed = this.#transform(this.#pending, true);
    this.#pending = "";
    return transformed.output;
  }

  redactComplete(data: string): string {
    return this.#transform(data, true).output;
  }

  #transform(
    data: string,
    final: boolean,
  ): { output: string; pending: string } {
    const output: string[] = [];
    let index = 0;
    while (index < data.length) {
      const candidates = this.#secretsByFirstCharacter.get(
        data.slice(index, index + 1),
      );
      const complete = candidates?.find((secret) =>
        data.startsWith(secret, index),
      );
      if (complete) {
        output.push(this.#marker);
        index += complete.length;
        continue;
      }

      if (!final && candidates) {
        const remainingLength = data.length - index;
        if (remainingLength < candidates[0]!.length) {
          const remainder = data.slice(index);
          if (
            candidates.some(
              (secret) =>
                remainder.length < secret.length &&
                secret.startsWith(remainder),
            )
          ) {
            return { output: output.join(""), pending: remainder };
          }
        }
      }

      output.push(data.slice(index, index + 1));
      index += 1;
    }
    return { output: output.join(""), pending: "" };
  }
}

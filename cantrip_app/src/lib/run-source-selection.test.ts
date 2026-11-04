import { describe, expect, it } from "vitest";
import { parseRunSource } from "./run-source-selection";

describe("explicit Run source selections", () => {
  it("reserves Host for an explicit Host selection and retains invalid Linux selections as unavailable", () => {
    expect(parseRunSource("host")).toBeNull();
    expect(parseRunSource("broken")).toBeUndefined();
    expect(
      parseRunSource(
        JSON.stringify({ kind: "runtime", runtimeId: crypto.randomUUID() }),
      ),
    ).toBeUndefined();
    const source = {
      kind: "binding",
      bindingId: crypto.randomUUID(),
      bindingGeneration: crypto.randomUUID(),
      attachmentGeneration: crypto.randomUUID(),
      runtimeGeneration: crypto.randomUUID(),
    };
    expect(parseRunSource(JSON.stringify(source))).toEqual(source);
  });
});

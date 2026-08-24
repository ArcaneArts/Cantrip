import { describe, expect, it } from "vitest";

import {
  readRunConfigurationSelection,
  reconcileRunConfigurationSelection,
  writeRunConfigurationSelection,
} from "./run-configuration-selection";

class MemoryStorage {
  readonly values = new Map<string, string>();
  getItem(key: string) {
    return this.values.get(key) ?? null;
  }
  setItem(key: string, value: string) {
    this.values.set(key, value);
  }
}

const scope = (name: string) => `owner:server:${name}`;

describe("Run configuration selection persistence", () => {
  it("keeps independent project selections in the scoped record", () => {
    const storage = new MemoryStorage();
    writeRunConfigurationSelection("project-a", "config-a", scope, storage);
    writeRunConfigurationSelection("project-b", "config-b", scope, storage);

    expect(readRunConfigurationSelection("project-a", scope, storage)).toBe(
      "config-a",
    );
    expect(readRunConfigurationSelection("project-b", scope, storage)).toBe(
      "config-b",
    );
  });

  it("fails closed on malformed storage and removes deleted selections", () => {
    const storage = new MemoryStorage();
    storage.setItem(scope("cantrip:run-configuration-selection"), "not-json");
    expect(
      readRunConfigurationSelection("project-a", scope, storage),
    ).toBeNull();

    writeRunConfigurationSelection("project-a", "config-a", scope, storage);
    writeRunConfigurationSelection("project-a", null, scope, storage);
    expect(
      readRunConfigurationSelection("project-a", scope, storage),
    ).toBeNull();
  });

  it("retains an available selection and otherwise chooses the first item", () => {
    expect(reconcileRunConfigurationSelection("b", ["a", "b"])).toBe("b");
    expect(reconcileRunConfigurationSelection("gone", ["a", "b"])).toBe("a");
    expect(reconcileRunConfigurationSelection(null, [])).toBeNull();
  });
});

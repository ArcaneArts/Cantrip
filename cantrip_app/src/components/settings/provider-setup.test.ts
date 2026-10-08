import { describe, expect, it } from "vitest";

import {
  providerSetupOptions,
  providerSetupUnavailableReason,
} from "./provider-setup";

const providers = [
  { id: "chatgpt", kind: "chatgpt" },
  { id: "grok", kind: "grok" },
  { id: "local", kind: "ollama" },
  { id: "api", kind: "openai-compatible" },
] as const;

describe("account provider setup availability", () => {
  it.each(["chatgpt", "grok"] as const)(
    "blocks a second %s provider and points to existing sign-ins",
    (kind) => {
      expect(providerSetupUnavailableReason(kind, providers)).toBe(
        `A ${kind === "chatgpt" ? "ChatGPT" : "SuperGrok"} provider already exists. Add sign-ins to that provider instead.`,
      );
    },
  );

  it.each(["chatgpt", "grok"] as const)(
    "allows the first %s provider, regardless of other provider types",
    (kind) => {
      expect(providerSetupUnavailableReason(kind, [])).toBeNull();
      expect(
        providerSetupUnavailableReason(
          kind,
          providers.filter((provider) => provider.kind !== kind),
        ),
      ).toBeNull();
    },
  );

  it.each(["chatgpt", "grok"] as const)(
    "allows editing %s itself, not converting another provider to its type",
    (kind) => {
      expect(providerSetupUnavailableReason(kind, providers, kind)).toBeNull();
      expect(
        providerSetupUnavailableReason(kind, providers, "local"),
      ).not.toBeNull();
    },
  );

  it("keeps every non-account setup repeatable", () => {
    for (const setup of providerSetupOptions) {
      if (setup.kind === "chatgpt" || setup.kind === "grok") continue;
      expect(providerSetupUnavailableReason(setup.kind, providers)).toBeNull();
    }
  });

  it("does not ignore another provider of the same kind when editing legacy duplicates", () => {
    expect(
      providerSetupUnavailableReason(
        "chatgpt",
        [...providers, { id: "legacy-chatgpt", kind: "chatgpt" }],
        "chatgpt",
      ),
    ).not.toBeNull();
  });
});

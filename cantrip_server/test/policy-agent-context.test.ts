import {
  POLICY_CONTEXT_BYTES_LIMIT,
  effectivePolicyListSchema,
} from "@cantrip/protocol";
import { describe, expect, it } from "vitest";

import {
  buildAgentPolicyContext,
  PolicyContextLimitError,
} from "../src/policies/agent-context.js";

describe("agent policy context", () => {
  it("preserves configured order without exposing policy internals", () => {
    const context = buildAgentPolicyContext(
      effectivePolicyListSchema.parse({
        policies: [
          {
            key: "manual-change-protocol",
            name: "Manual Change Protocol",
            summary:
              "Read the current policy with `cantrip policy read manual-change-protocol` before changing repository state.",
            mandatory: true,
            sources: [{ type: "mandatory" }],
          },
          {
            key: "release-review",
            name: "Release review",
            summary: "Run the release review before publishing.",
            mandatory: false,
            sources: [{ type: "project", projectId: "project-one" }],
          },
        ],
      }),
      "Cantrip",
    );

    expect(context).toContain("[manual-change-protocol]");
    expect(context!.indexOf("[manual-change-protocol]")).toBeLessThan(
      context!.indexOf("[release-review]"),
    );
    expect(context).not.toContain("project-one");
    expect(context).not.toContain("mandatory");
    expect(context).not.toContain("bodyMarkdown");
  });

  it("returns no application context when no policies are effective", () => {
    expect(
      buildAgentPolicyContext({ policies: [] }, "Empty project"),
    ).toBeNull();
  });

  it("rejects the complete context instead of truncating policies", () => {
    const policies = Array.from({ length: 40 }, (_, index) => ({
      key: `policy-${index}`,
      name: `Policy ${index}`,
      summary: "x".repeat(900),
      mandatory: true,
      sources: [{ type: "mandatory" as const }],
    }));

    expect(() =>
      buildAgentPolicyContext({ policies }, "Oversized project"),
    ).toThrowError(PolicyContextLimitError);
    expect(() =>
      buildAgentPolicyContext({ policies }, "Oversized project"),
    ).toThrowError(`Oversized project has 40 effective policies requiring`);
    expect(
      Buffer.byteLength(
        [
          "Effective Cantrip policies apply to this project.",
          ...policies.map(
            ({ key, name, summary }) => `[${key}] ${name}\n${summary}`,
          ),
        ].join("\n\n"),
      ),
    ).toBeGreaterThan(POLICY_CONTEXT_BYTES_LIMIT);
  });

  it("accepts the largest whole ordered set that fits the byte budget", () => {
    const policies = Array.from({ length: 31 }, (_, index) => ({
      key: `policy-${index}`,
      name: `Policy ${index}`,
      summary: "x".repeat(1_000),
      mandatory: true,
      sources: [{ type: "mandatory" as const }],
    }));
    const context = buildAgentPolicyContext({ policies }, "Budgeted project");

    expect(context).not.toBeNull();
    expect(Buffer.byteLength(context!, "utf8")).toBeLessThanOrEqual(
      POLICY_CONTEXT_BYTES_LIMIT,
    );
    expect(context).toContain("[policy-0]");
    expect(context).toContain("[policy-30]");
  });
});

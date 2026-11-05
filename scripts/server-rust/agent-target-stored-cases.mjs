// Actual persisted malformed records retain Source mapper timing and isolation.
import assert from "node:assert/strict";
import { json, label } from "./project-target-state.mjs";

export async function storedTargetCases({ fixture, call }) {
  for (const [table, id, recordKind] of [
    ["chats", "chat", "chat"],
    ["code_tabs", "code", "code-tab"],
    ["terminals", "terminal", "terminal"],
    ["explorers", "explorer", "explorer"],
    ["browsers", "browser", "browser"],
    ["project_views", "desktop", "project-view"],
  ]) {
    await fixture.sql([
      `UPDATE ${table} SET protected_label='{}'::jsonb WHERE id='${id}'`,
    ]);
    try {
      if (table === "chats") {
        const invalid = await call(
          "invalid stored chat summary is rejected",
          "target.list",
          {},
          400,
        );
        assert.deepEqual(invalid, {
          code: "invalid",
          error: "Cantrip MCP operation validation failed on the server.",
        });
        for (const args of [{ kind: "worker" }, { kind: 42 }]) {
          assert.deepEqual(
            await call(
              `stored chat is validated before ${JSON.stringify(args)}`,
              "target.list",
              args,
              400,
            ),
            invalid,
          );
        }
        // Source's placement-only chat context does not read its private label.
        await call(
          "chat inspection retains unused-label behavior",
          "target.inspect",
          {
            target: {
              kind: "surface",
              projectId: "github",
              surfaceKind: "chat",
              surfaceId: id,
            },
          },
        );
      } else {
        // These Source projections carry opaque metadata without parsing its
        // envelope. Retain that behavior and compare the complete raw result.
        await call(
          `opaque ${recordKind} projection retains Source validation timing`,
          "target.list",
        );
        await call(
          `opaque ${recordKind} projection still filters workers`,
          "target.list",
          { kind: "worker" },
        );
        assert.deepEqual(
          await call(
            `opaque ${recordKind} retains tool argument validation`,
            "target.list",
            { kind: 42 },
            400,
          ),
          { code: "invalid", error: "kind must be a string." },
        );
      }
      if (table === "code_tabs") {
        await call(
          "code inspection retains Source opaque projection",
          "target.inspect",
          {
            target: {
              kind: "surface",
              projectId: "github",
              surfaceKind: "code",
              surfaceId: id,
            },
          },
        );
      }
    } finally {
      await fixture.sql([
        `UPDATE ${table} SET protected_label=${json(label(recordKind))} WHERE id='${id}'`,
      ]);
    }
    await call(`restored ${recordKind} is readable`, "target.list");
  }
  await fixture.sql([
    "UPDATE code_tabs SET protected_label='{}'::jsonb WHERE id='other-code'",
  ]);
  try {
    const owned = await call(
      "foreign malformed records do not enter owned catalog",
      "target.list",
    );
    assert.ok(
      owned.data.targets.every((value) => value.target.projectId === "github"),
    );
  } finally {
    await fixture.sql([
      `UPDATE code_tabs SET protected_label=${json(label("code-tab"))} WHERE id='other-code'`,
    ]);
  }
}

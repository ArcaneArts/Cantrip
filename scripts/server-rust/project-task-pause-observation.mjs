// Keep complete Source query text and scalar parameters. Independent peer
// writes have different live Date parameters, checked by the caller's window.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
let queries;
export function projectPauseDiagnostic(value, normalizeClock) {
  queries ??= new Map(
    Object.entries(
      JSON.parse(
        readFileSync(
          new URL(
            "../../cantrip_server_rs/contracts/task-pause-queries.json",
            import.meta.url,
          ),
          "utf8",
        ),
      ),
    ).map(([kind, query]) => [query, kind]),
  );
  return value.replace(
    /Failed query: ([^\n]*)\nparams: ([^\n]*)/g,
    (original, query, parameters) => {
      assert.ok(
        queries.has(query),
        "actual pause diagnostic must preserve exact Source SQL",
      );
      const kind = queries.get(query);
      const dates = {
        chat: [1],
        pause: [3, 4, 5, 10],
        unstarted: [3, 4, 5, 10],
        heartbeat: [0, 1, 2, 7],
        settle: [1, 2, 7],
        queue: [],
      }[kind];
      return `Failed query: ${query}\nparams: ${parameters.replace(
        /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/g,
        (at, offset) => {
          const parameterIndex =
            parameters.slice(0, offset).split(",").length - 1;
          return dates.includes(parameterIndex)
            ? normalizeClock(at, { kind, parameterIndex })
            : at;
        },
      )}`;
    },
  );
}

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { appendServiceLogRecords } from "./log-viewer-model";
import { VirtualLogConsole } from "./log-settings";

describe("VirtualLogConsole", () => {
  it("renders full log rows without native hover tooltips", () => {
    const records = appendServiceLogRecords(
      [],
      [
        {
          cursor: 1,
          timestamp: "2026-08-22T13:05:49.949Z",
          system: "worker",
          level: "debug",
          message: "worker.command.completed",
          context: { operation: "model.chatgpt.catalog" },
        },
      ],
      "remote:worker",
    );

    const markup = renderToStaticMarkup(
      <VirtualLogConsole followTail={false} records={records} />,
    );

    expect(markup).toContain("worker.command.completed");
    expect(markup).toContain("model.chatgpt.catalog");
    expect(markup).not.toContain(" title=");
  });
});

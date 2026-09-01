import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { appendServiceLogRecords } from "./log-viewer-model";
import { LogSourceTabs, VirtualLogConsole } from "./log-settings";

describe("LogSourceTabs", () => {
  it("renders sources as horizontal tabs with the active source selected", () => {
    const markup = renderToStaticMarkup(
      <LogSourceTabs
        selectedSourceId="worker:local"
        sources={[
          {
            id: "client",
            kind: "client",
            label: "Client · This device",
            online: true,
            subtitle: "Desktop shell and webview",
          },
          {
            id: "worker:local",
            kind: "worker",
            label: "Worker · This machine",
            online: true,
            subtitle: "darwin · arm64",
          },
        ]}
        onSelect={() => undefined}
      />,
    );

    expect(markup).toContain('role="tablist"');
    expect(markup).toContain('aria-label="Log sources"');
    expect(markup).toContain('role="tab"');
    expect(markup).toContain('aria-selected="true"');
    expect(markup).toContain("Client · This device");
    expect(markup).toContain("Worker · This machine");
  });
});

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

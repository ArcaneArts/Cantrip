import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { LiveTrafficHistory } from "@/lib/live-traffic";

import {
  LiveTrafficSparkline,
  ServerLiveTrafficPanel,
} from "./server-live-traffic";

const timestamp = "2026-08-31T00:00:00.000Z";
const history: LiveTrafficHistory = {
  cursor: "1:1",
  epoch: "11111111-1111-4111-8111-111111111111",
  generatedAt: timestamp,
  instanceId: "instance",
  sampleIntervalSeconds: 0.25,
  windowSeconds: 600,
  current: {
    timestamp,
    downloadBytes: 125_000,
    uploadBytes: 125,
    httpRequests: 3,
    websocketMessages: { download: 4, upload: 2, total: 6 },
  },
  samples: [
    {
      timestamp,
      downloadBytes: 125_000,
      uploadBytes: 125,
      httpRequests: 3,
      websocketMessages: { download: 4, upload: 2, total: 6 },
    },
  ],
};

describe("server live traffic presentation", () => {
  it("renders current rates, all three compact charts, and measurement scope", () => {
    const markup = renderToStaticMarkup(
      <ServerLiveTrafficPanel history={history} status="available" />,
    );

    expect(markup).toContain("4 Mbps");
    expect(markup).toContain("4 kbps");
    expect(markup).toContain("12 req/s");
    expect(markup).toContain("24 msg/s");
    expect(markup).toContain("16 down/s · 8 up/s");
    expect(markup).toContain("10 minutes");
    expect(markup).toContain(
      'aria-label="10-minute upload and download bit-rate history"',
    );
    expect(markup).toContain(
      'aria-label="10-minute HTTP requests per second history"',
    );
    expect(markup).toContain(
      'aria-label="10-minute WebSocket messages per second history"',
    );
    expect(markup).toContain("direct worker traffic and transport overhead");
  });

  it("continues to display one-second rates and five-minute history from older servers", () => {
    const markup = renderToStaticMarkup(
      <ServerLiveTrafficPanel
        history={{ ...history, sampleIntervalSeconds: 1, windowSeconds: 300 }}
        status="available"
      />,
    );
    expect(markup).toContain("1 Mbps");
    expect(markup).toContain("3 req/s");
    expect(markup).toContain("6 msg/s");
    expect(markup).toContain(
      'aria-label="5-minute HTTP requests per second history"',
    );
  });

  it("renders graceful loading, unsupported, and disconnected states", () => {
    for (const [status, message] of [
      ["loading", "Loading server traffic history"],
      ["unsupported", "does not provide live traffic"],
      ["disconnected", "selected server is disconnected"],
    ] as const) {
      const markup = renderToStaticMarkup(
        <ServerLiveTrafficPanel history={null} status={status} />,
      );
      expect(markup).toContain(`data-live-traffic-status="${status}"`);
      expect(markup).toContain(message);
    }
  });

  it("labels every sparkline series instead of relying on color", () => {
    const markup = renderToStaticMarkup(
      <LiveTrafficSparkline
        ariaLabel="Transfer history"
        series={[
          { className: "stroke-blue", label: "Download", values: [1, 2] },
          { className: "stroke-pink", label: "Upload", values: [2, 1] },
        ]}
      />,
    );

    expect(markup).toContain('aria-label="Transfer history"');
    expect(markup).toContain('aria-label="Download"');
    expect(markup).toContain('aria-label="Upload"');
  });
});

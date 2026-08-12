import type {
  TunnelDestinationEndpoint,
  TunnelProtocolHint,
} from "@cantrip/protocol";

export interface BrowserTunnelTarget {
  destination: Extract<TunnelDestinationEndpoint, { kind: "worker-tcp" }>;
  label: string;
  protocolHint: Extract<
    TunnelProtocolHint,
    "http-websocket" | "https-websocket"
  >;
}

export function browserTunnelTarget(
  value: string,
  workerId: string,
): BrowserTunnelTarget {
  const url = new URL(value);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password
  ) {
    throw new Error(
      "Local Browser tunnels require an uncredentialed HTTP or HTTPS URL.",
    );
  }
  const hostname = url.hostname.toLowerCase();
  const host =
    hostname === "127.0.0.1" || hostname === "0.0.0.0"
      ? "127.0.0.1"
      : hostname === "localhost"
        ? "localhost"
        : hostname === "::1" || hostname === "[::1]"
          ? "::1"
          : null;
  if (!host) {
    throw new Error(
      "Local Browser tunnels may only target a loopback service on the selected worker.",
    );
  }
  const port = url.port
    ? Number(url.port)
    : url.protocol === "https:"
      ? 443
      : 80;
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("The Browser tunnel target port is invalid.");
  }
  return {
    destination: {
      kind: "worker-tcp",
      workerId,
      host,
      port,
    },
    label: `${host.includes(":") ? `[${host}]` : host}:${port}`,
    protocolHint:
      url.protocol === "https:" ? "https-websocket" : "http-websocket",
  };
}

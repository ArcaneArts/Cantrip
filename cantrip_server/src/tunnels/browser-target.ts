import type {
  BrowserTunnelRequest,
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
  input: Omit<BrowserTunnelRequest, "workerId">,
  workerId: string,
): BrowserTunnelTarget {
  return {
    destination: {
      kind: "worker-tcp",
      workerId,
      host: input.host,
      port: input.port,
    },
    label: `${input.host.includes(":") ? `[${input.host}]` : input.host}:${input.port}`,
    protocolHint:
      input.protocol === "https" ? "https-websocket" : "http-websocket",
  };
}

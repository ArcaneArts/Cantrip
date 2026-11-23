import type { TunnelProtocolHint } from "@cantrip/protocol";
import { NativeSelect } from "@/components/ui/native-select";
const protocols: Array<{ label: string; value: TunnelProtocolHint }> = [
  { value: "tcp", label: "TCP" },
  { value: "http", label: "HTTP" },
  { value: "https", label: "HTTPS" },
  { value: "http-websocket", label: "HTTP + WebSocket" },
  { value: "https-websocket", label: "HTTPS + WebSocket" },
  { value: "webdav", label: "WebDAV" },
];

export const tunnelInputClass =
  "h-9 w-full rounded-md border bg-background px-3 text-sm outline-none ring-ring focus:ring-2";

type Value = {
  protocolHint: TunnelProtocolHint;
  host: "127.0.0.1" | "localhost" | "::1";
  port: string;
};
export function TunnelTcpFields({
  value,
  linux,
  onChange,
}: {
  value: Value;
  linux: boolean;
  onChange(value: Partial<Value>): void;
}) {
  const inputClass = tunnelInputClass;
  return (
    <>
      <label className="grid gap-1.5 text-sm">
        <span className="font-medium">Protocol</span>
        <NativeSelect
          className={inputClass}
          value={value.protocolHint}
          onChange={(event) =>
            onChange({ protocolHint: event.target.value as TunnelProtocolHint })
          }
        >
          {protocols.map((protocol) => (
            <option key={protocol.value} value={protocol.value}>
              {protocol.label}
            </option>
          ))}
        </NativeSelect>
      </label>
      {!linux ? (
        <label className="grid gap-1.5 text-sm">
          <span className="font-medium">Worker host</span>
          <NativeSelect
            className={inputClass}
            value={value.host}
            onChange={(event) =>
              onChange({ host: event.target.value as Value["host"] })
            }
          >
            <option value="127.0.0.1">127.0.0.1</option>
            <option value="localhost">localhost</option>
            <option value="::1">::1</option>
          </NativeSelect>
        </label>
      ) : (
        <p className="self-end pb-2 text-xs text-muted-foreground">
          Connects to this workspace's Linux loopback address.
        </p>
      )}
      <label className="grid gap-1.5 text-sm">
        <span className="font-medium">Destination port</span>
        <input
          className={inputClass}
          inputMode="numeric"
          max={65_535}
          min={1}
          required
          type="number"
          value={value.port}
          onChange={(event) => onChange({ port: event.target.value })}
        />
      </label>
    </>
  );
}

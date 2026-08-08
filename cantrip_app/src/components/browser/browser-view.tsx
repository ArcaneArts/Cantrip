import type { BrowserSummary } from "@cantrip/protocol";
import {
  ArrowLeft,
  ArrowRight,
  ExternalLink,
  Globe2,
  RotateCw,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
} from "react";

import { Button } from "@/components/ui/button";
import { browserProxyUrl } from "@/lib/api";

function normalizeAddress(value: string): string | null {
  const candidate = /^[a-z][a-z\d+.-]*:/i.test(value.trim())
    ? value.trim()
    : `https://${value.trim()}`;
  try {
    const url = new URL(candidate);
    return url.protocol === "http:" || url.protocol === "https:"
      ? url.toString()
      : null;
  } catch {
    return null;
  }
}

export function browserUrlIsLocal(value: string): boolean {
  const url = new URL(value);
  const hostname = url.hostname.toLowerCase();
  if (hostname === "localhost" || hostname.endsWith(".local")) return true;
  if (hostname === "::1" || hostname === "[::1]") return true;
  const parts = hostname.split(".").map(Number);
  const first = parts[0] ?? -1;
  const second = parts[1] ?? -1;
  return (
    parts.length === 4 &&
    (first === 10 ||
      first === 127 ||
      (first === 169 && second === 254) ||
      (first === 172 && second >= 16 && second <= 31) ||
      (first === 192 && second === 168))
  );
}

export function BrowserView({
  browser,
  onNavigate,
}: {
  browser: BrowserSummary;
  onNavigate(url: string): void;
}) {
  const [address, setAddress] = useState(browser.url);
  const [entries, setEntries] = useState([browser.url]);
  const [entryIndex, setEntryIndex] = useState(0);
  const [reloadKey, setReloadKey] = useState(0);
  const [invalidAddress, setInvalidAddress] = useState(false);
  const frameRef = useRef<HTMLIFrameElement>(null);
  const currentUrl = entries[entryIndex] ?? browser.url;
  const localFrame = browserUrlIsLocal(currentUrl);
  const frameUrl = localFrame ? currentUrl : browserProxyUrl(currentUrl);

  useEffect(() => {
    setAddress(browser.url);
    setEntries([browser.url]);
    setEntryIndex(0);
    setInvalidAddress(false);
  }, [browser.id]);

  const visit = useCallback(
    (url: string) => {
      setEntries((current) => [...current.slice(0, entryIndex + 1), url]);
      setEntryIndex((current) => current + 1);
      setAddress(url);
      setInvalidAddress(false);
      onNavigate(url);
    },
    [entryIndex, onNavigate],
  );

  useEffect(() => {
    const receiveNavigation = (event: MessageEvent) => {
      if (event.source !== frameRef.current?.contentWindow) return;
      const data = event.data as { type?: unknown; url?: unknown } | null;
      if (
        data?.type !== "cantrip-browser-navigate" ||
        typeof data.url !== "string"
      )
        return;
      const normalized = normalizeAddress(data.url);
      if (normalized) visit(normalized);
    };
    window.addEventListener("message", receiveNavigation);
    return () => window.removeEventListener("message", receiveNavigation);
  }, [visit]);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const normalized = normalizeAddress(address);
    if (!normalized) {
      setInvalidAddress(true);
      return;
    }
    if (normalized === currentUrl) {
      setAddress(normalized);
      setReloadKey((value) => value + 1);
      return;
    }
    visit(normalized);
  };

  const move = (nextIndex: number) => {
    const url = entries[nextIndex];
    if (!url) return;
    setEntryIndex(nextIndex);
    setAddress(url);
    setInvalidAddress(false);
    onNavigate(url);
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-background">
      <div className="flex h-12 shrink-0 items-center gap-1.5 border-b bg-background px-3">
        <Button
          type="button"
          size="icon"
          variant="ghost"
          className="size-8"
          disabled={entryIndex === 0}
          onClick={() => move(entryIndex - 1)}
        >
          <ArrowLeft className="size-4" />
          <span className="sr-only">Back</span>
        </Button>
        <Button
          type="button"
          size="icon"
          variant="ghost"
          className="size-8"
          disabled={entryIndex >= entries.length - 1}
          onClick={() => move(entryIndex + 1)}
        >
          <ArrowRight className="size-4" />
          <span className="sr-only">Forward</span>
        </Button>
        <Button
          type="button"
          size="icon"
          variant="ghost"
          className="size-8"
          onClick={() => setReloadKey((value) => value + 1)}
        >
          <RotateCw className="size-3.5" />
          <span className="sr-only">Reload</span>
        </Button>
        <form className="min-w-0 flex-1" onSubmit={submit}>
          <div className="relative">
            <Globe2 className="pointer-events-none absolute left-3 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <input
              aria-label="Address"
              value={address}
              onChange={(event) => {
                setAddress(event.target.value);
                setInvalidAddress(false);
              }}
              className="h-8 w-full rounded-md border bg-background pl-9 pr-3 text-sm outline-none ring-ring placeholder:text-muted-foreground focus:ring-2"
              placeholder="Enter a URL"
              spellCheck={false}
            />
          </div>
        </form>
        <Button
          type="button"
          size="icon"
          variant="ghost"
          className="size-8"
          title="Open in your system browser"
          onClick={() =>
            window.open(currentUrl, "_blank", "noopener,noreferrer")
          }
        >
          <ExternalLink className="size-3.5" />
          <span className="sr-only">Open externally</span>
        </Button>
      </div>
      {invalidAddress ? (
        <p className="shrink-0 border-b bg-destructive/10 px-4 py-1.5 text-xs text-destructive">
          Enter a valid HTTP or HTTPS address.
        </p>
      ) : null}
      <div className="relative min-h-0 flex-1 bg-white">
        <iframe
          ref={frameRef}
          key={`${frameUrl}:${reloadKey}`}
          title={browser.title}
          src={frameUrl}
          className="absolute inset-0 size-full border-0"
          referrerPolicy="strict-origin-when-cross-origin"
          sandbox={
            localFrame
              ? "allow-downloads allow-forms allow-modals allow-popups allow-popups-to-escape-sandbox allow-same-origin allow-scripts"
              : "allow-downloads allow-forms allow-modals allow-popups allow-popups-to-escape-sandbox allow-scripts"
          }
        />
      </div>
    </div>
  );
}

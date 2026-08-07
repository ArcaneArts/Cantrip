import type { BrowserSummary } from "@cantrip/protocol";
import {
  ArrowLeft,
  ArrowRight,
  ExternalLink,
  Globe2,
  RotateCw,
} from "lucide-react";
import { useEffect, useState, type FormEvent } from "react";

import { Button } from "@/components/ui/button";

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
  const currentUrl = entries[entryIndex] ?? browser.url;

  useEffect(() => {
    setAddress(browser.url);
    setEntries([browser.url]);
    setEntryIndex(0);
    setInvalidAddress(false);
  }, [browser.id]);

  const visit = (url: string) => {
    setEntries((current) => [...current.slice(0, entryIndex + 1), url]);
    setEntryIndex((current) => current + 1);
    setAddress(url);
    setInvalidAddress(false);
    onNavigate(url);
  };

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
      <div className="flex h-12 shrink-0 items-center gap-1.5 border-b bg-card/40 px-3">
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
          key={`${currentUrl}:${reloadKey}`}
          title={browser.title}
          src={currentUrl}
          className="absolute inset-0 size-full border-0"
          referrerPolicy="strict-origin-when-cross-origin"
          sandbox="allow-downloads allow-forms allow-modals allow-popups allow-popups-to-escape-sandbox allow-same-origin allow-scripts"
        />
      </div>
    </div>
  );
}

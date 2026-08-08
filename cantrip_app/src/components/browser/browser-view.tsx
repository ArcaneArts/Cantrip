import type { BrowserSummary } from "@cantrip/protocol";
import { isTauri } from "@tauri-apps/api/core";
import type { Webview } from "@tauri-apps/api/webview";
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

function nativeBrowserLabel(browserId: string): string {
  return `cantrip-browser-${browserId}-${crypto.randomUUID()}`.replace(
    /[^A-Za-z0-9-/:_]/g,
    "-",
  );
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

interface NativeWebviewHandle {
  label: string;
  webview: Webview;
}

export function BrowserView({
  browser,
  onNavigate,
}: {
  browser: BrowserSummary;
  onNavigate(url: string): void;
}) {
  const desktop = isTauri();
  const [address, setAddress] = useState(browser.url);
  const [entries, setEntries] = useState([browser.url]);
  const [entryIndex, setEntryIndex] = useState(0);
  const [nativeUrl, setNativeUrl] = useState(browser.url);
  const [nativeReady, setNativeReady] = useState(false);
  const [nativeError, setNativeError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [invalidAddress, setInvalidAddress] = useState(false);
  const frameRef = useRef<HTMLIFrameElement>(null);
  const nativeSurfaceRef = useRef<HTMLDivElement>(null);
  const nativeWebviewRef = useRef<NativeWebviewHandle | null>(null);
  const onNavigateRef = useRef(onNavigate);
  onNavigateRef.current = onNavigate;

  const usingNative = desktop && !nativeError;
  const currentUrl = usingNative
    ? nativeUrl
    : (entries[entryIndex] ?? browser.url);
  const localFrame = browserUrlIsLocal(currentUrl);
  const frameUrl = localFrame ? currentUrl : browserProxyUrl(currentUrl);

  useEffect(() => {
    setAddress(browser.url);
    setEntries([browser.url]);
    setEntryIndex(0);
    setNativeUrl(browser.url);
    setNativeReady(false);
    setNativeError(null);
    setInvalidAddress(false);
  }, [browser.id]);

  useEffect(() => {
    if (!desktop) return;
    const surface = nativeSurfaceRef.current;
    if (!surface) return;

    let disposed = false;
    let resizeObserver: ResizeObserver | null = null;
    let pollTimer: number | null = null;
    let removeWindowListeners: (() => void) | null = null;
    const label = nativeBrowserLabel(browser.id);

    const start = async () => {
      const [
        { LogicalPosition, LogicalSize },
        { invoke },
        { Webview },
        windowApi,
      ] = await Promise.all([
        import("@tauri-apps/api/dpi"),
        import("@tauri-apps/api/core"),
        import("@tauri-apps/api/webview"),
        import("@tauri-apps/api/window"),
      ]);
      const initialBounds = surface.getBoundingClientRect();
      const webview = new Webview(windowApi.getCurrentWindow(), label, {
        url: browser.url,
        x: initialBounds.left,
        y: initialBounds.top,
        width: Math.max(1, initialBounds.width),
        height: Math.max(1, initialBounds.height),
        focus: true,
        devtools: true,
        zoomHotkeysEnabled: true,
      });
      nativeWebviewRef.current = { label, webview };

      await new Promise<void>((resolve, reject) => {
        void webview.once("tauri://created", () => resolve());
        void webview.once<unknown>("tauri://error", (event) => {
          reject(
            new Error(
              typeof event.payload === "string"
                ? event.payload
                : "The native browser webview could not be created.",
            ),
          );
        });
      });
      if (disposed) {
        await webview.close();
        return;
      }

      const syncBounds = async () => {
        const bounds = surface.getBoundingClientRect();
        if (bounds.width < 1 || bounds.height < 1) return;
        await Promise.all([
          webview.setPosition(new LogicalPosition(bounds.left, bounds.top)),
          webview.setSize(new LogicalSize(bounds.width, bounds.height)),
        ]);
      };
      const scheduleBounds = () => void syncBounds().catch(() => undefined);
      resizeObserver = new ResizeObserver(scheduleBounds);
      resizeObserver.observe(surface);
      window.addEventListener("resize", scheduleBounds);
      window.addEventListener("scroll", scheduleBounds, true);
      removeWindowListeners = () => {
        window.removeEventListener("resize", scheduleBounds);
        window.removeEventListener("scroll", scheduleBounds, true);
      };
      await syncBounds();
      setNativeReady(true);

      let lastUrl = browser.url;
      const syncUrl = async () => {
        const url = await invoke<string>("browser_webview_url", { label });
        const normalized = normalizeAddress(url);
        if (!normalized || normalized === lastUrl) return;
        lastUrl = normalized;
        setNativeUrl(normalized);
        setAddress(normalized);
        onNavigateRef.current(normalized);
      };
      pollTimer = window.setInterval(
        () => void syncUrl().catch(() => undefined),
        500,
      );
    };

    void start().catch(async (error: unknown) => {
      const handle = nativeWebviewRef.current;
      if (handle?.label === label) {
        nativeWebviewRef.current = null;
        await handle.webview.close().catch(() => undefined);
      }
      if (!disposed) {
        setNativeReady(false);
        setNativeError(error instanceof Error ? error.message : String(error));
      }
    });

    return () => {
      disposed = true;
      resizeObserver?.disconnect();
      removeWindowListeners?.();
      if (pollTimer !== null) window.clearInterval(pollTimer);
      const handle = nativeWebviewRef.current;
      if (handle?.label === label) {
        nativeWebviewRef.current = null;
        void handle.webview.close().catch(() => undefined);
      }
    };
  }, [browser.id, desktop]);

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
    if (usingNative) return;
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
  }, [usingNative, visit]);

  const invokeNative = async (
    command: "browser_webview_action" | "browser_webview_navigate",
    values: Record<string, unknown>,
  ) => {
    const handle = nativeWebviewRef.current;
    if (!handle || !nativeReady) return;
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke(command, { label: handle.label, ...values });
  };

  const navigateNative = async (url: string) => {
    setNativeUrl(url);
    setAddress(url);
    setInvalidAddress(false);
    onNavigate(url);
    await invokeNative("browser_webview_navigate", { url });
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const normalized = normalizeAddress(address);
    if (!normalized) {
      setInvalidAddress(true);
      return;
    }
    if (usingNative) {
      if (normalized === currentUrl) {
        void invokeNative("browser_webview_action", { action: "reload" });
      } else {
        void navigateNative(normalized);
      }
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

  const goBack = () => {
    if (usingNative) {
      void invokeNative("browser_webview_action", { action: "back" });
      return;
    }
    move(entryIndex - 1);
  };

  const goForward = () => {
    if (usingNative) {
      void invokeNative("browser_webview_action", { action: "forward" });
      return;
    }
    move(entryIndex + 1);
  };

  const reload = () => {
    if (usingNative) {
      void invokeNative("browser_webview_action", { action: "reload" });
      return;
    }
    setReloadKey((value) => value + 1);
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-background">
      <div className="flex h-12 shrink-0 items-center gap-1.5 border-b bg-background px-3">
        <Button
          type="button"
          size="icon"
          variant="ghost"
          className="size-8"
          disabled={!usingNative && entryIndex === 0}
          onClick={goBack}
        >
          <ArrowLeft className="size-4" />
          <span className="sr-only">Back</span>
        </Button>
        <Button
          type="button"
          size="icon"
          variant="ghost"
          className="size-8"
          disabled={!usingNative && entryIndex >= entries.length - 1}
          onClick={goForward}
        >
          <ArrowRight className="size-4" />
          <span className="sr-only">Forward</span>
        </Button>
        <Button
          type="button"
          size="icon"
          variant="ghost"
          className="size-8"
          onClick={reload}
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
      {nativeError ? (
        <p className="shrink-0 border-b bg-amber-500/10 px-4 py-1.5 text-xs text-amber-700 dark:text-amber-300">
          Native browser unavailable; using the web fallback. {nativeError}
        </p>
      ) : null}
      <div className="relative min-h-0 flex-1 bg-white">
        {desktop && !nativeError ? (
          <div
            ref={nativeSurfaceRef}
            className="absolute inset-0 bg-white"
            aria-label={`${browser.title} native browser surface`}
          />
        ) : (
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
        )}
      </div>
    </div>
  );
}

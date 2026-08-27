import { Check, Copy } from "lucide-react";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent,
  type ReactNode,
} from "react";

import {
  Popover,
  PopoverAnchor,
  PopoverContent,
} from "@/components/ui/popover";
import { cn } from "@/lib/utils";

import { markdownColorDetails } from "./markdown-color";

function CopyColorValue({
  copied,
  label,
  onCopy,
  value,
}: {
  copied: boolean;
  label: string;
  onCopy(): void;
  value: string;
}) {
  return (
    <button
      aria-label={`Copy ${label} value ${value}`}
      className="group flex w-full items-center gap-3 rounded-md px-2 py-1.5 text-left hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      onClick={onCopy}
      type="button"
    >
      <span className="w-8 shrink-0 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
        {label}
      </span>
      <code className="min-w-0 flex-1 truncate text-xs tabular-nums">
        {value}
      </code>
      {copied ? (
        <Check className="size-3.5 shrink-0 text-emerald-500" />
      ) : (
        <Copy className="size-3.5 shrink-0 text-muted-foreground opacity-60 group-hover:opacity-100" />
      )}
    </button>
  );
}

export function MarkdownColorPreview({
  children,
  className,
  hex,
  inverse = false,
}: {
  children?: ReactNode;
  className?: string;
  hex: string;
  inverse?: boolean;
}) {
  const details = useMemo(() => markdownColorDetails(hex), [hex]);
  const [open, setOpen] = useState(false);
  const [copiedValue, setCopiedValue] = useState<string | null>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastPointerType = useRef<string | null>(null);

  const cancelClose = () => {
    if (closeTimer.current === null) return;
    clearTimeout(closeTimer.current);
    closeTimer.current = null;
  };
  const scheduleClose = () => {
    cancelClose();
    closeTimer.current = setTimeout(() => {
      setOpen(false);
      closeTimer.current = null;
    }, 160);
  };
  useEffect(
    () => () => {
      if (closeTimer.current !== null) clearTimeout(closeTimer.current);
      if (copiedTimer.current !== null) clearTimeout(copiedTimer.current);
    },
    [],
  );
  if (!details) return children ?? null;

  const handlePointerEnter = (event: PointerEvent<HTMLElement>) => {
    if (event.pointerType !== "mouse") return;
    cancelClose();
    setOpen(true);
  };
  const handlePointerLeave = (event: PointerEvent<HTMLElement>) => {
    if (event.pointerType === "mouse") scheduleClose();
  };
  const copy = (value: string) => {
    void navigator.clipboard.writeText(value).then(
      () => {
        setCopiedValue(value);
        if (copiedTimer.current !== null) clearTimeout(copiedTimer.current);
        copiedTimer.current = setTimeout(() => {
          setCopiedValue(null);
          copiedTimer.current = null;
        }, 1_500);
      },
      () => setCopiedValue(null),
    );
  };
  const angle = ((details.hsv.h - 90) * Math.PI) / 180;
  const marker = {
    left: `${32 + Math.cos(angle) * 27}px`,
    top: `${32 + Math.sin(angle) * 27}px`,
  };

  return (
    <span
      className={cn(
        "inline-flex items-baseline gap-1 whitespace-nowrap",
        className,
      )}
    >
      {children}
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverAnchor asChild>
          <button
            aria-expanded={open}
            aria-haspopup="dialog"
            aria-label={`Show color details for ${details.hex}`}
            className={cn(
              "inline-block size-3.5 translate-y-[2px] rounded-[3px] border border-black/25 shadow-sm outline-none ring-offset-background focus-visible:ring-2 focus-visible:ring-ring",
              inverse && "border-white/40",
            )}
            data-markdown-color-preview={details.hex}
            onBlur={scheduleClose}
            onClick={() => {
              if (
                lastPointerType.current === null ||
                lastPointerType.current === "mouse"
              ) {
                setOpen(true);
              } else {
                setOpen((current) => !current);
              }
              lastPointerType.current = null;
            }}
            onFocus={() => {
              if (
                lastPointerType.current === null ||
                lastPointerType.current === "mouse"
              ) {
                cancelClose();
                setOpen(true);
              }
            }}
            onPointerDown={(event) => {
              lastPointerType.current = event.pointerType;
            }}
            onPointerEnter={handlePointerEnter}
            onPointerLeave={handlePointerLeave}
            style={{ backgroundColor: details.hex }}
            type="button"
          />
        </PopoverAnchor>
        <PopoverContent
          align="start"
          className="w-64 p-3"
          onBlurCapture={scheduleClose}
          onFocusCapture={cancelClose}
          onOpenAutoFocus={(event) => event.preventDefault()}
          onPointerEnter={handlePointerEnter}
          onPointerLeave={handlePointerLeave}
          side="top"
          sideOffset={6}
        >
          <div className="flex items-center gap-3 border-b pb-3">
            <div
              aria-label={`Hue ${details.hsv.h} degrees`}
              className="relative size-16 shrink-0 rounded-full"
              role="img"
              style={{
                background:
                  "conic-gradient(#ff0000, #ffff00, #00ff00, #00ffff, #0000ff, #ff00ff, #ff0000)",
              }}
            >
              <span className="absolute inset-2 rounded-full bg-popover" />
              <span
                className="absolute size-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white bg-black shadow"
                style={marker}
              />
              <span
                className="absolute inset-[18px] rounded-full border border-black/20"
                style={{ backgroundColor: details.hex }}
              />
            </div>
            <div className="min-w-0">
              <p className="text-sm font-semibold">Color preview</p>
              <p className="mt-1 font-mono text-xs text-muted-foreground">
                {details.hex}
              </p>
              <p className="mt-1 text-[10px] text-muted-foreground">
                Click any value to copy
              </p>
            </div>
          </div>
          <div className="mt-2 space-y-0.5">
            <CopyColorValue
              copied={copiedValue === details.hex}
              label="Hex"
              value={details.hex}
              onCopy={() => copy(details.hex)}
            />
            <CopyColorValue
              copied={copiedValue === details.rgbText}
              label="RGB"
              value={details.rgbText}
              onCopy={() => copy(details.rgbText)}
            />
            <CopyColorValue
              copied={copiedValue === details.hsvText}
              label="HSV"
              value={details.hsvText}
              onCopy={() => copy(details.hsvText)}
            />
          </div>
        </PopoverContent>
      </Popover>
    </span>
  );
}

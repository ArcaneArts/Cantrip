import { Check, Copy, TriangleAlert } from "lucide-react";
import {
  Children,
  isValidElement,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/** Read the original code child, before syntax highlighting adds token elements. */
export function markdownCodeBlockText(children: ReactNode): string {
  if (typeof children === "string" || typeof children === "number")
    return String(children);
  if (isValidElement<{ children?: ReactNode }>(children))
    return markdownCodeBlockText(children.props.children);
  return Children.toArray(children)
    .map((child) =>
      typeof child === "string" ||
      typeof child === "number" ||
      isValidElement(child)
        ? markdownCodeBlockText(child)
        : "",
    )
    .join("");
}

export function MarkdownCodeBlock({
  children,
  inverse = false,
}: {
  children: ReactNode;
  inverse?: boolean;
}) {
  const code = markdownCodeBlockText(children);
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  const attempt = useRef(0);
  const resetTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    setState("idle");
    return () => {
      attempt.current += 1;
      if (resetTimer.current !== null) clearTimeout(resetTimer.current);
    };
  }, [code]);

  const copy = async () => {
    const current = ++attempt.current;
    if (resetTimer.current !== null) clearTimeout(resetTimer.current);
    try {
      await navigator.clipboard.writeText(code);
      if (attempt.current !== current) return;
      setState("copied");
    } catch {
      if (attempt.current !== current) return;
      setState("failed");
    }
    resetTimer.current = setTimeout(() => setState("idle"), 1_500);
  };

  return (
    <div
      data-markdown-code-block=""
      className={cn(
        "relative my-3 grid min-w-0 max-w-full grid-cols-[minmax(0,1fr)] rounded-lg border",
        inverse
          ? "markdown-code-inverse border-white/15 bg-black/25"
          : "bg-muted/60",
      )}
    >
      <pre className="col-start-1 row-start-1 m-0 min-w-0 max-w-full overflow-x-auto p-3 pr-12">
        {children}
      </pre>
      {/* A sibling of the horizontal scroller: sticky follows the surrounding
          Markdown viewport and remains bounded by this code block's bottom. */}
      <Button
        aria-label="Copy code"
        className={cn(
          "sticky top-2 z-10 col-start-1 row-start-1 m-2 size-7 self-start justify-self-end border bg-background/90 text-foreground shadow-sm",
          inverse &&
            "border-white/20 bg-black/70 text-white hover:bg-black/80 hover:text-white",
        )}
        onClick={() => void copy()}
        size="icon"
        title={
          state === "copied"
            ? "Copied"
            : state === "failed"
              ? "Copy failed — try again"
              : "Copy code"
        }
        type="button"
        variant="ghost"
      >
        {state === "copied" ? (
          <Check className="size-3.5" />
        ) : state === "failed" ? (
          <TriangleAlert className="size-3.5" />
        ) : (
          <Copy className="size-3.5" />
        )}
      </Button>
      <span className="sr-only" role="status">
        {state === "copied"
          ? "Code copied"
          : state === "failed"
            ? "Unable to copy code. Try again."
            : null}
      </span>
    </div>
  );
}

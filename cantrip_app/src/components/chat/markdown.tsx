import MarkdownRenderer from "react-markdown";
import remarkGfm from "remark-gfm";

import { SyntaxHighlightedCode } from "@/components/chat/markdown-code";
import { cn } from "@/lib/utils";

export function handleMarkdownLinkClick(
  event: { preventDefault(): void },
  href: string | undefined,
  onOpenLink: ((url: string) => void) | undefined,
): boolean {
  if (!onOpenLink || !href) return false;
  event.preventDefault();
  onOpenLink(href);
  return true;
}

export function Markdown({
  children,
  inverse = false,
  onOpenLink,
}: {
  children: string;
  inverse?: boolean;
  onOpenLink?(url: string): void;
}) {
  return (
    <div
      data-selectable-text="true"
      className={cn(
        "min-w-0 max-w-full break-words text-sm leading-6",
        inverse && "text-primary-foreground",
      )}
    >
      <MarkdownRenderer
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ children: linkChildren, ...props }) => (
            <a
              {...props}
              className={cn(
                "break-all underline underline-offset-4",
                inverse
                  ? "decoration-primary-foreground/60"
                  : "decoration-foreground/40",
              )}
              rel="noreferrer"
              target="_blank"
              onClick={(event) =>
                handleMarkdownLinkClick(event, props.href, onOpenLink)
              }
            >
              {linkChildren}
            </a>
          ),
          blockquote: ({ children: quoteChildren }) => (
            <blockquote
              className={cn(
                "my-3 border-l-2 pl-4 italic",
                inverse
                  ? "border-primary-foreground/40 text-primary-foreground/80"
                  : "text-muted-foreground",
              )}
            >
              {quoteChildren}
            </blockquote>
          ),
          code: ({ children: codeChildren, className, node, ...props }) => {
            const fenced =
              Boolean(className) ||
              (node?.position?.start.line !== node?.position?.end.line &&
                String(codeChildren).endsWith("\n"));
            if (fenced) {
              return (
                <SyntaxHighlightedCode {...props} className={className}>
                  {codeChildren}
                </SyntaxHighlightedCode>
              );
            }
            return (
              <code
                {...props}
                className={cn(
                  className,
                  "whitespace-pre-wrap break-all rounded bg-muted px-1.5 py-0.5 font-mono text-[0.85em] text-foreground",
                  inverse && "bg-white/15 text-white",
                )}
              >
                {codeChildren}
              </code>
            );
          },
          h1: ({ children: headingChildren }) => (
            <h1 className="mb-3 mt-6 text-xl font-semibold leading-tight first:mt-0">
              {headingChildren}
            </h1>
          ),
          h2: ({ children: headingChildren }) => (
            <h2 className="mb-2 mt-5 text-lg font-semibold leading-tight first:mt-0">
              {headingChildren}
            </h2>
          ),
          h3: ({ children: headingChildren }) => (
            <h3 className="mb-2 mt-4 font-semibold first:mt-0">
              {headingChildren}
            </h3>
          ),
          hr: () => <hr className="my-5" />,
          li: ({ children: itemChildren }) => (
            <li className="my-1 pl-1">{itemChildren}</li>
          ),
          ol: ({ children: listChildren }) => (
            <ol className="my-3 list-decimal space-y-1 pl-6">{listChildren}</ol>
          ),
          p: ({ children: paragraphChildren }) => (
            <p className="my-3 first:mt-0 last:mb-0">{paragraphChildren}</p>
          ),
          pre: ({ children: preChildren }) => (
            <pre
              className={cn(
                "my-3 max-w-full overflow-x-auto rounded-lg border p-3",
                inverse
                  ? "markdown-code-inverse border-white/15 bg-black/25"
                  : "bg-muted/60",
              )}
            >
              {preChildren}
            </pre>
          ),
          table: ({ children: tableChildren }) => (
            <div className="my-4 max-w-full overflow-x-auto">
              <table className="w-full border-collapse text-left text-sm">
                {tableChildren}
              </table>
            </div>
          ),
          td: ({ children: cellChildren }) => (
            <td className="border px-3 py-2 align-top">{cellChildren}</td>
          ),
          th: ({ children: cellChildren }) => (
            <th className="border bg-muted/60 px-3 py-2 font-medium">
              {cellChildren}
            </th>
          ),
          ul: ({ children: listChildren }) => (
            <ul className="my-3 list-disc space-y-1 pl-6">{listChildren}</ul>
          ),
        }}
      >
        {children}
      </MarkdownRenderer>
    </div>
  );
}

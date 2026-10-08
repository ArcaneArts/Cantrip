import { useRef } from "react";
import { Markdown } from "@/components/chat/markdown";

export function explorerMarkdownDestination(
  href: string,
  sourcePath: string,
): { path: string; fragment: string } | null {
  if (/^(?:[a-z][a-z\d+.-]*:|\/\/)/iu.test(href)) return null;
  const fragmentIndex = href.indexOf("#");
  const fragment =
    fragmentIndex < 0 ? "" : decodeURIComponent(href.slice(fragmentIndex + 1));
  const path = decodeURIComponent(
    href
      .slice(0, fragmentIndex < 0 ? undefined : fragmentIndex)
      .split("?")[0] ?? "",
  );
  if (/^(?:[\/\\]|[a-z]:)/iu.test(path) || /[\\\0]/u.test(path))
    throw new Error("This Markdown link points outside this project.");
  const parts = path ? sourcePath.split("/").slice(0, -1) : [];
  for (const part of (path || sourcePath).split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (!parts.length)
        throw new Error("This Markdown link points outside this project.");
      parts.pop();
    } else parts.push(part);
  }
  if (!parts.length)
    throw new Error("This Markdown link does not point to a file.");
  return { path: parts.join("/"), fragment };
}

export function ExplorerMarkdown({
  children,
  path,
  onOpenFile,
  onError,
}: {
  children: string;
  path: string;
  onOpenFile(path: string): void;
  onError(message: string): void;
}) {
  const article = useRef<HTMLElement>(null);
  return (
    <article
      ref={article}
      className="px-4"
      data-content-gutter="markdown"
      data-elite-ignore=""
    >
      <Markdown
        headingAnchors
        onNavigateLink={(href) => {
          try {
            const destination = explorerMarkdownDestination(href, path);
            if (!destination) return false;
            if (destination.path === path && destination.fragment) {
              [
                ...(article.current?.querySelectorAll<HTMLElement>("[id]") ??
                  []),
              ]
                .find((e) => e.id === destination.fragment)
                ?.scrollIntoView({ block: "start" });
            } else onOpenFile(destination.path);
          } catch (error) {
            onError(
              error instanceof Error
                ? error.message
                : "This Markdown link could not be opened.",
            );
          }
          return true;
        }}
      >
        {children}
      </Markdown>
    </article>
  );
}

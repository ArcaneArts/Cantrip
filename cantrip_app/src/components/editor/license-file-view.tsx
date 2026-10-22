import { ArrowUpRight, Scale } from "lucide-react";
import { useEffect, useState } from "react";
import type { LicenseSummary } from "./license-catalog";

export function LicenseFileView({
  path,
  content,
}: {
  path: string;
  content: string;
}) {
  const [match, setMatch] = useState<{
    content: string;
    license: LicenseSummary | null;
  } | null>(null);
  useEffect(() => {
    let cancelled = false;
    void import("./license-detection")
      .then(({ detectLicense }) => detectLicense(content))
      .then((license) => {
        if (!cancelled) setMatch({ content, license });
      })
      .catch(() => {
        if (!cancelled) setMatch({ content, license: null });
      });
    return () => {
      cancelled = true;
    };
  }, [content]);
  const license = match?.content === content ? match.license : null;
  const name = path.replaceAll("\\", "/").split("/").at(-1) ?? "License";
  return (
    <div className="h-full overflow-auto" data-license-view="true">
      <article className="mx-auto w-full max-w-4xl px-5 py-8 sm:px-10 sm:py-10">
        <header className="mb-7 flex items-center gap-3 text-muted-foreground">
          <Scale className="size-5 shrink-0" aria-hidden="true" />
          <h1 className="break-all text-sm font-medium tracking-wide">
            {name}
          </h1>
        </header>
        {license ? (
          <section
            aria-label="License summary"
            className="mb-8 rounded-xl border border-border/70 bg-card/30 p-5 sm:p-6"
          >
            <div className="mb-3 flex flex-wrap items-center gap-3">
              <h2 className="text-lg font-semibold tracking-tight">
                {license.name}
              </h2>
              <span className="rounded-full bg-muted/50 px-2.5 py-1 text-[11px] text-muted-foreground">
                {license.category}
              </span>
            </div>
            <p className="text-sm leading-6">{license.summary}</p>
            <p className="mt-2 text-sm leading-6 text-muted-foreground">
              {license.conditions}
            </p>
            {license.reference ? (
              <a
                href={license.reference}
                target="_blank"
                rel="noopener noreferrer"
                className="mt-4 inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline"
              >
                License reference{" "}
                <ArrowUpRight className="size-3.5" aria-hidden="true" />
              </a>
            ) : null}
          </section>
        ) : null}
        <pre
          aria-label="License text"
          className="whitespace-pre-wrap break-words font-sans text-sm leading-7 text-foreground/90"
        >
          {content}
        </pre>
      </article>
    </div>
  );
}

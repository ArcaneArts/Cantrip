import type { CodeAppearance } from "@cantrip/protocol";
import { useEffect, useState } from "react";

import { ExplorerCodeEditor } from "@/components/explorer/explorer-code-editor";
import { INLINE_CODE_WORKBENCH_RETENTION_MS } from "@/components/explorer/use-retained-inline-workbench";
import { cn } from "@/lib/utils";

export function RetainedExplorerCodeEditor({
  activePath,
  appearance,
  explorerId,
  prewarm,
  retained,
  workerOnline,
  workerId,
  worktreeId,
}: {
  activePath: string | null;
  appearance: CodeAppearance;
  explorerId: string;
  prewarm: boolean;
  retained: boolean;
  workerOnline: boolean;
  workerId: string;
  worktreeId: string;
}) {
  const [retainedPath, setRetainedPath] = useState(activePath);

  useEffect(() => {
    if (!retained) {
      setRetainedPath(null);
      return;
    }
    if (activePath) {
      setRetainedPath(activePath);
      return;
    }
    if (!retainedPath) return;

    const timeout = setTimeout(
      () => setRetainedPath(null),
      INLINE_CODE_WORKBENCH_RETENTION_MS,
    );
    return () => clearTimeout(timeout);
  }, [activePath, retained, retainedPath]);

  const path = retained ? (activePath ?? retainedPath) : null;
  if (!retained || (!prewarm && !path)) return null;

  const visible = activePath !== null;
  return (
    <div
      aria-hidden={!visible}
      className={cn("min-h-0 flex-1", visible ? "flex" : "hidden")}
      data-slot="retained-explorer-code-editor"
    >
      <ExplorerCodeEditor
        active={visible}
        appearance={appearance}
        explorerId={explorerId}
        path={path}
        workerOnline={workerOnline}
        workerId={workerId}
        worktreeId={worktreeId}
      />
    </div>
  );
}

import type { CodeAppearance } from "@cantrip/protocol";
import { useEffect, useState } from "react";

import {
  ExplorerCodeEditor,
  type ExplorerCodeEditorLifecycleActions,
} from "@/components/explorer/explorer-code-editor";
import { INLINE_CODE_WORKBENCH_RETENTION_MS } from "@/components/explorer/use-retained-inline-workbench";
import { cn } from "@/lib/utils";

export function RetainedExplorerCodeEditor({
  appearance,
  explorerId,
  onLifecycleChange,
  onReady,
  path,
  prewarm,
  retained,
  visible,
  workerOnline,
  workerId,
  worktreeId,
}: {
  appearance: CodeAppearance;
  explorerId: string;
  onLifecycleChange?(actions: ExplorerCodeEditorLifecycleActions | null): void;
  onReady?: () => void;
  path: string | null;
  prewarm: boolean;
  retained: boolean;
  visible: boolean;
  workerOnline: boolean;
  workerId: string;
  worktreeId: string;
}) {
  const [retainedPath, setRetainedPath] = useState(path);

  useEffect(() => {
    if (!retained) {
      setRetainedPath(null);
      return;
    }
    if (path) {
      setRetainedPath(path);
      return;
    }
    if (!retainedPath) return;

    const timeout = setTimeout(
      () => setRetainedPath(null),
      INLINE_CODE_WORKBENCH_RETENTION_MS,
    );
    return () => clearTimeout(timeout);
  }, [path, retained, retainedPath]);

  const workbenchPath = retained ? (path ?? retainedPath) : null;
  if (!retained || (!prewarm && !workbenchPath)) return null;

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
        onLifecycleChange={onLifecycleChange}
        onReady={onReady}
        path={workbenchPath}
        workerOnline={workerOnline}
        workerId={workerId}
        worktreeId={worktreeId}
      />
    </div>
  );
}

import type { CodeAppearance } from "@cantrip/protocol";
import { useEffect, useRef, useState } from "react";

import {
  ExplorerCodeEditor,
  type ExplorerCodeEditorLifecycleActions,
} from "@/components/explorer/explorer-code-editor";
import { INLINE_CODE_WORKBENCH_RETENTION_MS } from "@/components/explorer/use-retained-inline-workbench";
import { clientLogger } from "@/lib/client-log-relay";
import { explorerFileIntentContext } from "@/lib/explorer-lifecycle-trace";
import { cn } from "@/lib/utils";

export function RetainedExplorerCodeEditor({
  appearance,
  explorerId,
  onLifecycleChange,
  onReady,
  onWorkbenchReadinessChange,
  path,
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
  onWorkbenchReadinessChange?(ready: boolean): void;
  path: string | null;
  retained: boolean;
  visible: boolean;
  workerOnline: boolean;
  workerId: string;
  worktreeId: string;
}) {
  const retainerInstanceId = useRef(crypto.randomUUID()).current;
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
  const diagnosticState = {
    pathPresent: workbenchPath !== null,
    retained,
    retainedPathPresent: retainedPath !== null,
    visible,
  };
  const diagnosticStateRef = useRef(diagnosticState);
  diagnosticStateRef.current = diagnosticState;
  const previousPathRef = useRef(workbenchPath);

  useEffect(() => {
    clientLogger.info("Explorer Code retainer mounted", {
      ...explorerFileIntentContext(explorerId),
      ...diagnosticStateRef.current,
      event: "code.editor.retainer.mounted",
      explorerId,
      lifecycleKind: "mounted",
      operation: "retain-editor",
      retainerInstanceId,
      status: "completed",
      subsystem: "code",
      workerId,
      worktreeId,
    });
    return () => {
      clientLogger.info("Explorer Code retainer unmounted", {
        ...explorerFileIntentContext(explorerId),
        ...diagnosticStateRef.current,
        event: "code.editor.retainer.unmounted",
        explorerId,
        lifecycleKind: "unmounted",
        operation: "release-editor",
        reasonCode: "react-unmount",
        retainerInstanceId,
        status: "completed",
        subsystem: "code",
        workerId,
        worktreeId,
      });
    };
  }, [explorerId, retainerInstanceId, workerId, worktreeId]);

  useEffect(() => {
    const previousPath = previousPathRef.current;
    clientLogger.info("Explorer Code retention state observed", {
      ...explorerFileIntentContext(explorerId),
      ...diagnosticStateRef.current,
      event: "code.editor.retention.observed",
      explorerId,
      lifecycleKind: "updated",
      operation: "retain-editor",
      pathChanged: previousPath !== workbenchPath,
      retainerInstanceId,
      status: "observed",
      subsystem: "code",
      workerId,
      worktreeId,
    });
    previousPathRef.current = workbenchPath;
  }, [
    explorerId,
    path,
    retained,
    retainedPath,
    retainerInstanceId,
    visible,
    workbenchPath,
    workerId,
    worktreeId,
  ]);

  if (!retained || !workbenchPath) return null;

  return (
    <div
      aria-hidden={!visible}
      inert={visible ? undefined : true}
      className={cn(
        "min-h-0 flex-1",
        visible
          ? "flex"
          : "pointer-events-none invisible absolute inset-0 flex",
      )}
      data-slot="retained-explorer-code-editor"
    >
      <ExplorerCodeEditor
        active={visible}
        appearance={appearance}
        explorerId={explorerId}
        onLifecycleChange={onLifecycleChange}
        onReady={onReady}
        onWorkbenchReadinessChange={onWorkbenchReadinessChange}
        path={workbenchPath}
        workerOnline={workerOnline}
        workerId={workerId}
        worktreeId={worktreeId}
      />
    </div>
  );
}

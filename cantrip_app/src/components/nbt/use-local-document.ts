import { useEffect, useState, useSyncExternalStore } from "react";
import type { DocumentRecoveryBinding } from "@/lib/document-recovery-encryption";
import { NbtLocalReferenceSession } from "@/lib/nbt/local-reference";
import { NbtLocalDocument } from "@/lib/nbt/local-document";
const idle = () => () => {};
const empty = () => null;

export function useNbtLocalDocument(
  openBinding: () => Promise<Omit<DocumentRecoveryBinding, "tabId">>,
  viewId: string,
  enabled: boolean,
) {
  const [epoch, setEpoch] = useState(0),
    [state, setState] = useState<{
      binding: typeof openBinding;
      view: string;
      document?: NbtLocalDocument;
      error?: unknown;
    } | null>(null);
  useEffect(() => {
    if (!enabled) {
      setState(null);
      return;
    }
    let closed = false,
      document: NbtLocalDocument | undefined;
    setState(null);
    void (async () => {
      const binding = await openBinding();
      document = await NbtLocalDocument.open(() =>
        NbtLocalReferenceSession.open(binding, viewId),
      );
      if (closed) document.dispose();
      else setState({ binding: openBinding, view: viewId, document });
    })().catch((error) => {
      if (!closed) setState({ binding: openBinding, view: viewId, error });
    });
    return () => {
      closed = true;
      document?.dispose();
    };
  }, [openBinding, viewId, enabled, epoch]);
  const current =
      enabled && state?.binding === openBinding && state.view === viewId
        ? state
        : null,
    document = current?.document,
    snapshot = useSyncExternalStore(
      document?.subscribe ?? idle,
      document?.getSnapshot ?? empty,
      empty,
    );
  return {
    document,
    snapshot,
    error: current?.error,
    retry: () => setEpoch((value) => value + 1),
  };
}

import { useCallback, useEffect, useRef, useState } from "react";
import type { NbtDocumentClient } from "@cantrip/nbt/document";
import { exportNbtCopy } from "@/lib/nbt/export-copy";
import { openNbtExport } from "@/lib/nbt/open-export";

export function useNbtExport(
  client: NbtDocumentClient | null | undefined,
  name: string,
) {
  const work = useRef<{
      client: NbtDocumentClient;
      controller: AbortController;
    } | null>(null),
    [state, setState] = useState<{
      busy: boolean;
      bytes: number;
      error?: boolean;
      message?: string;
    }>({ busy: false, bytes: 0 });
  useEffect(() => {
    setState({ busy: false, bytes: 0 });
    return () => {
      const previous = work.current;
      work.current = null;
      previous?.controller.abort(new Error("The NBT export view was retired."));
    };
  }, [client]);
  const start = useCallback(() => {
    if (!client || work.current) return;
    const job = { client, controller: new AbortController() };
    work.current = job;
    setState({ busy: true, bytes: 0 });
    let last = performance.now(),
      bytes = 0;
    void exportNbtCopy(
      client,
      name,
      openNbtExport,
      job.controller.signal,
      (size) => {
        bytes = size;
        if (work.current === job && performance.now() - last >= 100) {
          last = performance.now();
          setState({ busy: true, bytes });
        }
      },
    )
      .then(
        (result) => {
          if (work.current === job)
            setState({ busy: false, bytes, message: result?.message });
        },
        (error) => {
          if (work.current === job)
            setState({
              busy: false,
              bytes,
              error: !job.controller.signal.aborted,
              message: job.controller.signal.aborted
                ? "Export cancelled. The original draft is retained."
                : error instanceof Error
                  ? error.message
                  : "The NBT copy could not be exported.",
            });
        },
      )
      .finally(() => {
        if (work.current === job) work.current = null;
      });
  }, [client, name]);
  return {
    ...state,
    start,
    busyRef: work,
    cancel: () =>
      work.current?.controller.abort(new Error("Export cancelled.")),
  };
}

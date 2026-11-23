import { useEffect, useState, useSyncExternalStore } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { NativeRuntimeHandoffEditor } from "@/components/chat/native-runtime-handoff-editor";
import { useRuntimeHandoff } from "@/components/chat/use-runtime-handoff";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { clientEncryption } from "@/lib/client-encryption";
import {
  getClientSessionIdentitySnapshot,
  onClientSessionIdentityChanged,
} from "@/lib/client-session";
import { readTaskGoalRuntimeSource } from "@/lib/native-runtime-handoff";

/** Transfer an actual unused Goal response or private cycle. The server captures
 * its keeper Source again at begin; this view never submits or replays input. */
export function TaskGoalProviderTransfer({
  chatId,
  queued,
  visible,
}: {
  chatId: string;
  queued: boolean;
  visible: boolean;
}) {
  const client = useQueryClient();
  const [identity, setIdentity] = useState(getClientSessionIdentitySnapshot);
  const encryption = useSyncExternalStore(
    clientEncryption.subscribe,
    clientEncryption.getSnapshot,
    clientEncryption.getSnapshot,
  );
  const unlocked = encryption.status === "ready";
  const [open, setOpen] = useState(false);
  const [captureAttempt, setCaptureAttempt] = useState(0);
  useEffect(
    () =>
      onClientSessionIdentityChanged(() =>
        setIdentity(getClientSessionIdentitySnapshot()),
      ),
    [],
  );
  useEffect(() => setOpen(false), [chatId, identity, unlocked]);
  const controller = useRuntimeHandoff({
    chatId,
    binding: null,
    identity,
    open: visible && open,
    observe: visible,
    unlocked,
  });
  const source = useQuery({
    queryKey: [
      "task-goal-runtime-source",
      chatId,
      identity,
      unlocked,
      captureAttempt,
    ],
    enabled: Boolean(
      visible &&
      open &&
      queued &&
      identity &&
      unlocked &&
      controller.query.isSuccess &&
      !controller.active &&
      !controller.busy &&
      !controller.unconfirmed,
    ),
    queryFn: ({ signal }) =>
      readTaskGoalRuntimeSource({ chatId, identity: identity! }, signal),
    retry: false,
    staleTime: Infinity,
    refetchOnMount: "always",
  });
  useEffect(() => {
    if (!source.data) return;
    void client.invalidateQueries({
      queryKey: ["native-runtime-handoffs", chatId],
    });
    void client.invalidateQueries({ queryKey: ["native-settings", chatId] });
  }, [source.data, source.dataUpdatedAt, chatId, client]);
  if (
    !visible ||
    (!queued && !controller.active && !controller.unconfirmed && !open)
  )
    return null;
  return (
    <>
      <Button
        variant="outline"
        size="sm"
        disabled={!identity || !unlocked}
        onClick={() => {
          setCaptureAttempt((value) => value + 1);
          setOpen(true);
        }}
      >
        {controller.active
          ? "Provider transfer in progress"
          : "Change queued Goal provider"}
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-h-[85dvh] overflow-y-auto sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Goal provider</DialogTitle>
            <DialogDescription>
              Move a queued Goal response or cycle to another provider, account,
              or model. The Goal and its history are retained.
            </DialogDescription>
          </DialogHeader>
          {source.isFetching ? (
            <p role="status">Reading the queued Goal…</p>
          ) : null}
          {source.error && !controller.active ? (
            <div role="alert" className="space-y-2 text-sm">
              <p>{source.error.message}</p>
            </div>
          ) : null}
          {!controller.active && !controller.unconfirmed ? (
            <Button
              variant="outline"
              disabled={!queued || source.isFetching || controller.busy}
              onClick={() => void source.refetch()}
            >
              Refresh queued Goal
            </Button>
          ) : null}
          {controller.query.error ? (
            <p role="alert" className="text-sm text-destructive">
              {controller.query.error.message}
            </p>
          ) : null}
          {controller.binding && identity ? (
            <NativeRuntimeHandoffEditor
              controller={controller}
              binding={controller.binding}
              identity={identity}
              disabled={
                !visible ||
                !queued ||
                source.isFetching ||
                (!controller.active &&
                  source.data?.binding?.bindingId !==
                    controller.binding.bindingId) ||
                Boolean(source.error)
              }
              allowSameProviderModelChange
              description="The queued Goal continues automatically after transfer. Changing accounts or models within one provider keeps its queue position. A different provider places it at the end of that provider’s queue."
            />
          ) : null}
        </DialogContent>
      </Dialog>
    </>
  );
}

import { NativeAccountDefaultsEditor } from "./native-account-defaults-editor";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { NativeModelSettingsController } from "./use-native-model-settings";
import type {
  NativeModelDirty,
  NativeModelDraft,
} from "./native-model-settings";

export function NativeModelSettingsPicker({
  controller,
  open,
  onOpenChange,
  disabled = false,
}: {
  controller: NativeModelSettingsController;
  open: boolean;
  onOpenChange(open: boolean): void;
  disabled?: boolean;
}) {
  const { binding, selected, inventory, observed, update } = controller;
  const [storedDraft, setDraft] = useState<NativeModelDraft | null>(null);
  const [dirty, setDirty] = useState<NativeModelDirty>({});
  const [editingBindingId, setEditingBindingId] = useState<string | null>(null);
  const [editorIdentity, setEditorIdentity] = useState(observed.identity);
  const draft =
    observed.encryption.status === "ready" &&
    observed.confirmed &&
    editorIdentity === observed.identity
      ? storedDraft
      : null;
  useEffect(() => {
    setDraft(null);
    setDirty({});
    setEditingBindingId(null);
    setEditorIdentity(observed.identity);
  }, [observed.identity]);
  useEffect(() => {
    if (!open && selected) {
      setDraft({ ...selected, routeId: controller.selectedRouteId });
      setDirty({});
      setEditingBindingId(binding?.bindingId ?? null);
    }
  }, [
    open,
    selected?.model,
    selected?.effort,
    selected?.serviceTier,
    selected?.multiAgentEnabled,
    selected?.subagentModel,
    selected?.subagentReasoningEffort,
    controller.selectedRouteId,
    binding?.bindingId,
  ]);
  // A slash command can open the picker before its first settings read finishes.
  useEffect(() => {
    if (open && !draft && selected) {
      setDraft({ ...selected, routeId: controller.selectedRouteId });
      setEditingBindingId(binding?.bindingId ?? null);
    }
  }, [open, draft, selected, controller.selectedRouteId, binding?.bindingId]);
  const changeOpen = (next: boolean) => {
    if (next && selected) {
      setDraft({ ...selected, routeId: controller.selectedRouteId });
      setEditingBindingId(binding?.bindingId ?? null);
      setDirty({});
    }
    onOpenChange(next);
  };
  useEffect(() => {
    if (!observed.confirmed && observed.encryption.status !== "ready") {
      setDraft(null);
      setDirty({});
      setEditingBindingId(null);
    }
  }, [observed.encryption, observed.confirmed]);
  const model = inventory.data?.models.find(
    (candidate) => candidate.routeId === draft?.routeId,
  );
  const efforts = [
    ...new Set([
      null,
      ...(model?.catalog?.supportedReasoningEfforts?.map(
        (option) => option.effort,
      ) ?? []),
      draft?.effort ?? null,
    ]),
  ];
  const pending =
    controller.pending > 0 ||
    controller.localStatus === "requesting" ||
    controller.localStatus === "queued";
  const status = observed.state.data?.desiredStatus;
  const editable = Boolean(
    draft &&
    binding &&
    inventory.data &&
    binding.bindingId === inventory.data.bindingId &&
    editingBindingId === binding.bindingId &&
    observed.confirmed,
  );
  return (
    <Dialog open={open} onOpenChange={changeOpen}>
      <Button
        type="button"
        variant="ghost"
        className="h-8 max-w-72 justify-start px-1.5 text-left"
        disabled={disabled}
        aria-label="Configure agent models"
        onClick={() => changeOpen(true)}
      >
        <span className="min-w-0">
          <span className="block truncate text-xs font-medium">
            {selected?.model ?? "Session model"}
          </span>
          <span className="block truncate text-[10px] text-muted-foreground">
            {pending
              ? "Change pending"
              : (selected?.effort ?? "Default reasoning")}
          </span>
        </span>
      </Button>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>Session model settings</DialogTitle>
          <DialogDescription>
            Choose a model in this session’s provider and account. Changes can
            be queued while the agent is working.
          </DialogDescription>
        </DialogHeader>
        {observed.confirmed ? (
          <p
            className="text-xs text-muted-foreground"
            aria-label="Effective model settings"
          >
            Confirmed: {observed.confirmed.model} ·{" "}
            {observed.confirmed.effort ?? "Default reasoning"} ·{" "}
            {observed.confirmed.serviceTier === "default"
              ? "Standard service"
              : (observed.confirmed.serviceTier ?? "No service tier override")}
          </p>
        ) : (
          <p role="status">
            {observed.encryption.status !== "ready"
              ? "Unlock encryption to view session settings."
              : observed.state.error
                ? "Session settings could not be read."
                : "Reading confirmed session settings…"}
          </p>
        )}
        {pending ? (
          <p role="status" className="text-xs">
            Requested changes are awaiting confirmation.
          </p>
        ) : null}
        {status === "rejected" || controller.localStatus === "rejected" ? (
          <p role="status" className="text-xs text-destructive">
            The latest change was rejected. Confirmed settings remain shown
            above.
          </p>
        ) : null}
        {status === "uncertain" || controller.localStatus === "uncertain" ? (
          <p role="status" className="text-xs">
            The latest change has an unconfirmed outcome. Check session settings
            before submitting it again.
          </p>
        ) : null}
        <label className="space-y-1 text-sm">
          Model
          <select
            aria-label="Session model"
            className="w-full rounded border bg-background p-2"
            value={draft?.routeId ?? ""}
            disabled={!editable || update.isPending}
            onChange={(event) => {
              const choice = inventory.data?.models.find(
                (candidate) => candidate.routeId === event.target.value,
              );
              if (choice) {
                setDraft((current) =>
                  current
                    ? {
                        ...current,
                        routeId: choice.routeId,
                        model: choice.name,
                      }
                    : current,
                );
                setDirty((current) => ({ ...current, model: true }));
              }
            }}
          >
            <option value="" disabled>
              {draft?.model ?? "Choose model"}
            </option>
            {inventory.data?.models.map((candidate) => (
              <option key={candidate.routeId} value={candidate.routeId}>
                {candidate.catalog?.displayName ?? candidate.name}
                {inventory.data?.models.filter(
                  (entry) => entry.name === candidate.name,
                ).length > 1
                  ? ` (${candidate.routeId})`
                  : ""}
              </option>
            ))}
          </select>
        </label>
        <label className="space-y-1 text-sm">
          Reasoning effort
          <select
            aria-label="Session reasoning effort"
            className="w-full rounded border bg-background p-2"
            value={draft?.effort ?? ""}
            disabled={!editable || update.isPending}
            onChange={(event) => {
              setDraft((current) =>
                current
                  ? { ...current, effort: event.target.value || null }
                  : current,
              );
              setDirty((current) => ({ ...current, effort: true }));
            }}
          >
            {efforts.map((effort) => (
              <option key={effort ?? "default"} value={effort ?? ""}>
                {effort ?? "Default"}
              </option>
            ))}
          </select>
        </label>
        <label className="space-y-1 text-sm">
          Service tier
          <input
            aria-label="Session service tier"
            className="w-full rounded border bg-background p-2"
            placeholder="No service tier override"
            value={draft?.serviceTier ?? ""}
            disabled={!editable || update.isPending}
            onChange={(event) => {
              setDraft((current) =>
                current
                  ? { ...current, serviceTier: event.target.value || null }
                  : current,
              );
              setDirty((current) => ({ ...current, serviceTier: true }));
            }}
          />
          <span className="flex gap-2">
            <Button
              type="button"
              variant="outline"
              disabled={!editable || update.isPending}
              onClick={() => {
                setDraft((current) =>
                  current ? { ...current, serviceTier: null } : current,
                );
                setDirty((current) => ({ ...current, serviceTier: true }));
              }}
            >
              No service tier override
            </Button>
            <Button
              type="button"
              variant="outline"
              disabled={!editable || update.isPending}
              onClick={() => {
                setDraft((current) =>
                  current ? { ...current, serviceTier: "default" } : current,
                );
                setDirty((current) => ({ ...current, serviceTier: true }));
              }}
            >
              Standard service
            </Button>
          </span>
          <span className="block text-xs text-muted-foreground">
            Empty leaves the service tier unspecified. Standard service selects
            the standard tier explicitly.
          </span>
        </label>
        {draft?.multiAgentEnabled !== undefined ? (
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              aria-label="Enable subagents"
              checked={draft.multiAgentEnabled}
              disabled={!editable || update.isPending}
              onChange={(event) => {
                setDraft((current) =>
                  current
                    ? { ...current, multiAgentEnabled: event.target.checked }
                    : current,
                );
                setDirty((current) => ({
                  ...current,
                  multiAgentEnabled: true,
                }));
              }}
            />{" "}
            Enable subagents
          </label>
        ) : null}
        {draft?.subagentModel !== undefined ? (
          <label className="space-y-1 text-sm">
            Subagent model
            <select
              aria-label="Subagent model"
              className="w-full rounded border bg-background p-2"
              value={draft.subagentModel ?? ""}
              disabled={!editable || update.isPending}
              onChange={(event) => {
                setDraft((current) =>
                  current
                    ? { ...current, subagentModel: event.target.value || null }
                    : current,
                );
                setDirty((current) => ({ ...current, subagentModel: true }));
              }}
            >
              <option value="">Inherit parent model</option>
              {[
                ...new Set([
                  ...(inventory.data?.models.map((entry) => entry.name) ?? []),
                  ...(draft.subagentModel ? [draft.subagentModel] : []),
                ]),
              ].map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </select>
          </label>
        ) : (
          <p className="text-xs text-muted-foreground">
            This session has not reported subagent model settings yet.
          </p>
        )}
        {draft?.subagentReasoningEffort !== undefined ? (
          <label className="space-y-1 text-sm">
            Subagent reasoning effort
            <select
              aria-label="Subagent reasoning effort"
              className="w-full rounded border bg-background p-2"
              value={draft.subagentReasoningEffort ?? ""}
              disabled={!editable || update.isPending}
              onChange={(event) => {
                setDraft((current) =>
                  current
                    ? {
                        ...current,
                        subagentReasoningEffort: event.target.value || null,
                      }
                    : current,
                );
                setDirty((current) => ({
                  ...current,
                  subagentReasoningEffort: true,
                }));
              }}
            >
              <option value="">Inherit parent reasoning</option>
              {[
                ...new Set([
                  ...(inventory.data?.models
                    .find(
                      (entry) =>
                        entry.name === (draft.subagentModel ?? draft.model),
                    )
                    ?.catalog?.supportedReasoningEfforts?.map(
                      (entry) => entry.effort,
                    ) ?? []),
                  ...(draft.subagentReasoningEffort
                    ? [draft.subagentReasoningEffort]
                    : []),
                ]),
              ].map((effort) => (
                <option key={effort} value={effort}>
                  {effort}
                </option>
              ))}
            </select>
          </label>
        ) : null}
        <p className="text-xs text-muted-foreground">
          Provider and account changes require a session migration.
        </p>
        {controller.error ? (
          <p role="alert" className="text-xs text-destructive">
            {controller.error.message}
          </p>
        ) : null}
        {editingBindingId && binding?.bindingId !== editingBindingId ? (
          <p role="alert">
            The session changed. Reopen model settings before saving.
          </p>
        ) : null}
        {!observed.confirmed || controller.error ? (
          <Button
            variant="outline"
            disabled={observed.state.isFetching}
            onClick={() => {
              void observed.state.refetch();
            }}
          >
            Retry settings read
          </Button>
        ) : null}
        {open && editable && binding && draft && observed.identity ? (
          <NativeAccountDefaultsEditor
            key={binding.bindingId}
            binding={binding}
            identity={observed.identity}
            values={{
              model: draft.model,
              model_reasoning_effort: draft.effort,
              service_tier: draft.serviceTier ?? null,
            }}
          />
        ) : null}
        <DialogFooter>
          <Button variant="outline" onClick={() => changeOpen(false)}>
            Close
          </Button>
          <Button
            disabled={
              !editable ||
              update.isPending ||
              !Object.values(dirty).some(Boolean)
            }
            onClick={() => {
              if (draft && editingBindingId)
                void update
                  .mutateAsync({ draft, dirty, bindingId: editingBindingId })
                  .then(() => onOpenChange(false))
                  .catch(() => {});
            }}
          >
            {update.isPending ? "Submitting…" : "Save settings"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

import {
  ModelReasoningPicker,
  type ModelReasoningPickerProps,
} from "./model-reasoning-picker";
import { NativeRuntimeHandoffEditor } from "./native-runtime-handoff-editor";
import { useNativeSettingsState } from "./use-native-settings-state";
import { useRuntimeHandoff } from "./use-runtime-handoff";

/** Keep the request identity alive when the dialog closes. Standalone models
 * remain per-message choices; transfer uses their canonical native input owner. */
export function ChatModelReasoningPicker({
  chatId,
  workerId,
  scratchRootId,
  contextKind,
  ...props
}: ModelReasoningPickerProps & {
  chatId: string;
  workerId: string | null;
  scratchRootId: string | null;
  contextKind: "project" | "standalone";
}) {
  const standalone = contextKind === "standalone";
  const observed = useNativeSettingsState(
    chatId,
    standalone && Boolean(props.open),
  );
  const source = observed.state.data?.binding;
  const binding =
    standalone &&
    source?.contextKind === "standalone" &&
    source.chatId === chatId &&
    source.workerId === workerId &&
    source.projectId === null &&
    source.placementId === scratchRootId
      ? source
      : null;
  const handoff = useRuntimeHandoff({
    binding,
    identity: observed.identity,
    open: standalone && Boolean(props.open),
    unlocked: observed.encryption.status === "ready",
  });
  const transferring =
    handoff.active || handoff.busy || Boolean(handoff.unconfirmed);
  return (
    <ModelReasoningPicker
      {...props}
      readOnly={props.readOnly || transferring}
      readOnlyReason={
        transferring
          ? "Model edits will be available after the provider transfer finishes."
          : props.readOnlyReason
      }
      renderAdditionalSettings={
        standalone
          ? ({ dirty, pending }) =>
              binding &&
              observed.identity &&
              observed.encryption.status === "ready" ? (
                <NativeRuntimeHandoffEditor
                  controller={handoff}
                  binding={binding}
                  identity={observed.identity}
                  disabled={Boolean(props.disabled) || dirty || pending}
                />
              ) : null
          : props.renderAdditionalSettings
      }
    />
  );
}

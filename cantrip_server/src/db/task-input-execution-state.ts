import type { TaskInferenceInputState } from "./task-inference-inputs.js";

/** Physical ownership advances across Resume; immutable input/source identity
 * remains on the canonical round for checkpoint and history correlation. */
export function currentTaskInputExecution(state: TaskInferenceInputState) {
  return state.resumption ?? state;
}

/** A not-yet-bound Resume cannot erase the actual owner of its saved checkpoint. */
export function taskCheckpointExecution(state: TaskInferenceInputState) {
  const resumed = state.resumption;
  return resumed?.nativeExecution && resumed.nativeOwner
    ? resumed
    : (resumed?.checkpointOwner ?? state);
}

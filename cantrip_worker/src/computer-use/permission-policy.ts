import {
  YOLO_PERMISSION_PROFILE_ID,
  type ChatPermissionProfileState,
} from "@cantrip/protocol";
import type { ComputerUseOperation } from "@cantrip/protocol/computer-use";

export type CuaPermissionProfile = Pick<
  ChatPermissionProfileState,
  "selectedId" | "effectiveId" | "forcedByWorktreePolicy"
>;

/** Cursor means logical CUA state only, never native pointer/keyboard input. */
export type CuaPermissionClass = "inventory" | "capture" | "cursor";

export interface CuaPermissionDecision {
  kind: "allow" | "approval-required";
  classes: CuaPermissionClass[];
}

const operationClasses = {
  // Capability discovery and Stop require the caller's authenticated execution
  // scope, but never a separate operation approval. Stop must remain available.
  "capabilities.get": [],
  "session.close": [],
  // These operations expose window/monitor metadata, including the current
  // session target. Opening/attaching alone does not capture screen pixels.
  "targets.list": ["inventory"],
  "session.open": ["inventory"],
  "session.state": ["inventory"],
  "target.attach": ["inventory"],
  "observation.snapshot": ["capture"],
  // Detach clears the observed target; the other operations alter only the
  // agent's separately rendered logical cursor, not the human system cursor.
  "target.detach": ["cursor"],
  "cursor.configure": ["cursor"],
  "cursor.move": ["cursor"],
} satisfies Record<ComputerUseOperation, readonly CuaPermissionClass[]>;

/**
 * Project the existing Cantrip profile onto this observation-only tranche.
 * Authenticated execution ownership and durable approval handling belong to
 * the caller. This function neither checks native capabilities nor prompts.
 *
 * Only the exact selected YOLO profile suppresses operation approval. Primary
 * worktree policy may force its effective filesystem profile to read-only;
 * that does not constrain these non-filesystem, non-native-input operations.
 * Conversely, an effective profile or engine approvalPolicy of "never" does
 * not establish that the user selected YOLO (e.g. structured read-only Codex).
 */
export function computerUsePermissionDecision(
  operation: ComputerUseOperation,
  profile: CuaPermissionProfile,
): CuaPermissionDecision {
  const classes = [...operationClasses[operation]];
  return {
    kind:
      classes.length === 0 || profile.selectedId === YOLO_PERMISSION_PROFILE_ID
        ? "allow"
        : "approval-required",
    classes,
  };
}

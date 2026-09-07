import type { CuaInputCommand, CuaInputReceipt, CuaPoint } from "./types.js";

/** Requested preparation only; receipts still report actual sampled effects. */
export function inputRequestsPreparation(command: CuaInputCommand): boolean {
  return (
    command.kind === "prepared-press" ||
    command.kind === "drag" ||
    (command.kind === "timeline" &&
      command.frames.some(
        (frame) =>
          frame.pointerDown !== undefined &&
          frame.pointerModifiers.length === 0,
      ))
  );
}

/** Validate the actual response against the requested delivery and logical point. */
export function matchesInputReceipt(
  receipt: CuaInputReceipt,
  method: CuaInputReceipt["method"],
  position?: CuaPoint,
  activation?: boolean,
): boolean {
  if (receipt.method !== method) return false;
  if (activation !== undefined && receipt.activation !== activation)
    return false;
  if (
    ["focus", "window-input", "background-prepared-press"].includes(method) &&
    !receipt.activation
  )
    return false;
  if (method === "system-media") {
    return (
      receipt.outcome === "unknown" &&
      !receipt.activation &&
      receipt.windowDelivery === undefined &&
      receipt.position === undefined &&
      receipt.globalPosition === undefined
    );
  }
  if (method === "process-coordinate" || method.startsWith("background-")) {
    if (
      receipt.outcome !== "unknown" ||
      receipt.windowDelivery !== "unverified"
    )
      return false;
  } else if (
    receipt.outcome !== "dispatched" ||
    receipt.windowDelivery !== undefined
  )
    return false;
  return (
    position === undefined ||
    (receipt.position?.x === position.x &&
      receipt.position.y === position.y &&
      receipt.globalPosition !== undefined)
  );
}

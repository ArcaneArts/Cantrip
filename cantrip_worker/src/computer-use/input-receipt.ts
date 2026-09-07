import type { CuaInputReceipt, CuaPoint } from "./types.js";

/** Validate the actual response against the requested delivery and logical point. */
export function matchesInputReceipt(
  receipt: CuaInputReceipt,
  method: CuaInputReceipt["method"],
  position?: CuaPoint,
): boolean {
  if (receipt.method !== method) return false;
  if (
    ["focus", "window-input", "background-prepared-press"].includes(method) &&
    !receipt.activation
  )
    return false;
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

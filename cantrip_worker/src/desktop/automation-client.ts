import type {
  ComputerUseClient,
  ToolResult,
} from "@zavora-ai/computer-use-mcp/client";

import type { DesktopDisplaySize } from "./desktop-frame-source.js";

export interface DesktopInputTargetOptions {
  focusStrategy: "strict";
  targetWindowId: number;
}

export interface DesktopAutomationClient {
  activateWindow(windowId: number, timeoutMs?: number): Promise<ToolResult>;
  click(
    x: number,
    y: number,
    targetApp?: string,
    options?: DesktopInputTargetOptions,
  ): Promise<ToolResult>;
  close(): Promise<void>;
  doubleClick(x: number, y: number): Promise<ToolResult>;
  getDisplaySize(): Promise<ToolResult>;
  key(
    combo: string,
    targetApp?: string,
    options?: DesktopInputTargetOptions,
  ): Promise<ToolResult>;
  middleClick(
    x: number,
    y: number,
    targetApp?: string,
    options?: DesktopInputTargetOptions,
  ): Promise<ToolResult>;
  mouseDown(
    x: number,
    y: number,
    targetApp?: string,
    options?: DesktopInputTargetOptions,
  ): Promise<ToolResult>;
  mouseUp(
    x: number,
    y: number,
    targetApp?: string,
    options?: DesktopInputTargetOptions,
  ): Promise<ToolResult>;
  moveMouse(
    x: number,
    y: number,
    targetApp?: string,
    options?: DesktopInputTargetOptions,
  ): Promise<ToolResult>;
  readClipboard(): Promise<ToolResult>;
  rightClick(
    x: number,
    y: number,
    targetApp?: string,
    options?: DesktopInputTargetOptions,
  ): Promise<ToolResult>;
  screenshot(options: { quality: number; width: number }): Promise<ToolResult>;
  scroll(
    x: number,
    y: number,
    direction: "up" | "down" | "left" | "right",
    amount: number,
    targetApp?: string,
    options?: DesktopInputTargetOptions,
  ): Promise<ToolResult>;
  type(
    text: string,
    targetApp?: string,
    options?: DesktopInputTargetOptions,
  ): Promise<ToolResult>;
}

export type DesktopAutomationClientFactory =
  () => Promise<DesktopAutomationClient>;

function resultText(result: ToolResult): string | null {
  return result.content.find((item) => item.type === "text")?.text ?? null;
}

export function assertComputerUseResult(
  result: ToolResult,
  operation: string,
): void {
  if (!result.isError) return;
  throw new Error(resultText(result) ?? `${operation} failed.`);
}

export function computerUseResultObject(
  result: ToolResult,
): Record<string, unknown> | null {
  if (result.structuredContent) return result.structuredContent;
  const text = resultText(result);
  if (!text) return null;
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object"
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

export function desktopDisplaySize(result: ToolResult): DesktopDisplaySize {
  assertComputerUseResult(result, "Reading the desktop size");
  const value = computerUseResultObject(result);
  const width = Number(value?.width);
  const height = Number(value?.height);
  if (
    !Number.isFinite(width) ||
    width <= 0 ||
    !Number.isFinite(height) ||
    height <= 0
  ) {
    throw new Error("The worker returned an invalid desktop size.");
  }
  return { width: Math.round(width), height: Math.round(height) };
}

export function desktopImageBytes(result: ToolResult): Uint8Array {
  assertComputerUseResult(result, "Capturing the desktop");
  const image = result.content.find((item) => item.type === "image");
  if (!image || image.type !== "image") {
    throw new Error(
      resultText(result) ?? "The worker did not return a desktop frame.",
    );
  }
  return Buffer.from(image.data, "base64");
}

export function desktopClipboardText(result: ToolResult): string {
  assertComputerUseResult(result, "Reading the desktop clipboard");
  return resultText(result) ?? "";
}

export async function createDesktopAutomationClient(): Promise<DesktopAutomationClient> {
  const [{ createComputerUseServer }, { connectInProcess }] = await Promise.all(
    [
      import("@zavora-ai/computer-use-mcp"),
      import("@zavora-ai/computer-use-mcp/client"),
    ],
  );
  // Cantrip's authenticated Remote Surface is the approval boundary. The
  // desktop backend must not write a second log containing user input.
  const previousAuditSetting = process.env.COMPUTER_USE_AUDIT_LOG;
  process.env.COMPUTER_USE_AUDIT_LOG = "false";
  try {
    return (await connectInProcess(
      createComputerUseServer({
        elicitApproval: async () => true,
        profile: "full",
      }),
    )) as ComputerUseClient;
  } finally {
    if (previousAuditSetting === undefined) {
      delete process.env.COMPUTER_USE_AUDIT_LOG;
    } else {
      process.env.COMPUTER_USE_AUDIT_LOG = previousAuditSetting;
    }
  }
}

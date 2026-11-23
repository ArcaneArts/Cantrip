// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  explorerEntrySchema,
  type StandaloneChatSummary,
} from "@cantrip/protocol";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import * as api from "@/lib/api";
import {
  saveEditorBoolean,
  saveEditorOpeningMode,
} from "@/lib/editor-preferences";
import { ChatFilePreview } from "./standalone-chat-file-preview";

vi.mock("@/lib/api", async (original) => ({
  ...(await original<typeof import("@/lib/api")>()),
  loadStandaloneChatFileMedia: vi.fn(),
  getStandaloneChatFile: vi.fn(),
}));
vi.mock("@/components/editor/native-code-editor", () => ({
  NativeCodeEditor: ({ readOnly }: { readOnly: boolean }) => (
    <textarea readOnly={readOnly} aria-label="Test editor" />
  ),
}));
let root: Root, node: HTMLDivElement, client: QueryClient;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  localStorage.clear();
  vi.stubGlobal(
    "URL",
    class extends URL {
      static createObjectURL = vi.fn(() => "blob:test");
      static revokeObjectURL = vi.fn();
    },
  );
  node = document.createElement("div");
  root = createRoot(node);
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});
afterEach(async () => {
  await act(async () => root.unmount());
  client.clear();
  vi.unstubAllGlobals();
});
async function open(path: string) {
  await act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <ChatFilePreview
          chatId="chat"
          chat={
            {
              id: "chat",
              activeWorkerId: "worker",
              activeScratchRootId: "scratch",
            } as StandaloneChatSummary
          }
          entry={explorerEntrySchema.parse({
            path,
            name: path,
            kind: "file",
            size: 4,
            modifiedAt: "2026-11-02T00:00:00Z",
            viewable: true,
            markdown: false,
          })}
          onSaved={() => {}}
        />
      </QueryClientProvider>,
    ),
  );
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
}

it.each(["audio", "video"] as const)(
  "uses the %s looping preference in the Chat file preview",
  async (kind) => {
    saveEditorBoolean(`${kind}-loop`, true);
    vi.mocked(api.loadStandaloneChatFileMedia).mockResolvedValue(
      new Blob(["media"], { type: `${kind}/test` }),
    );
    await open(kind === "audio" ? "song.mp3" : "movie.mp4");
    expect(node.querySelector<HTMLMediaElement>(kind)?.loop).toBe(true);
  },
);

it("uses the original-size image preference in Chat file previews", async () => {
  saveEditorBoolean("image-fit", false);
  vi.mocked(api.loadStandaloneChatFileMedia).mockResolvedValue(
    new Blob(["image"], { type: "image/png" }),
  );
  await open("image.png");
  expect(node.querySelector("img")?.className).toContain("max-w-none");
});

it("opens other text read-only and can switch between Edit and Preview", async () => {
  saveEditorOpeningMode("text", "preview");
  vi.mocked(api.getStandaloneChatFile).mockResolvedValue({
    path: "file.txt",
    content: "text",
    size: 4,
    markdown: false,
    version: "a".repeat(64),
  });
  await open("file.txt");
  expect(node.querySelector("textarea")?.readOnly).toBe(true);
  const button = (label: string) =>
    [...node.querySelectorAll("button")].find(
      (value) => value.textContent === label,
    )!;
  await act(async () => button("Edit").click());
  expect(node.querySelector("textarea")?.readOnly).toBe(false);
  await act(async () => button("Preview").click());
  expect(node.querySelector("textarea")?.readOnly).toBe(true);
});

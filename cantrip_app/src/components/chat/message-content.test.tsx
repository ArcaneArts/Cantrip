import type { ChatMessage } from "@cantrip/protocol";
import TestRenderer, { act } from "react-test-renderer";
import { describe, expect, it, vi } from "vitest";

import { MessageContent } from "./message-content";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

describe("MessageContent file links", () => {
  it.each([undefined, "commentary"])(
    "preserves the message worktree for %s text",
    async (phase) => {
      const onOpenFile = vi.fn();
      const message = {
        id: "message-1",
        chatId: "chat-1",
        worktreeId: "original-task",
        content: [{ type: "text", text: "[File](src/app.ts)", phase }],
      } as ChatMessage;
      let renderer!: TestRenderer.ReactTestRenderer;
      await act(async () => {
        renderer = TestRenderer.create(
          <MessageContent message={message} onOpenFile={onOpenFile} />,
        );
      });

      const preventDefault = vi.fn();
      renderer.root.findByType("a").props.onClick({ preventDefault });
      expect(onOpenFile).toHaveBeenCalledExactlyOnceWith(
        "src/app.ts",
        "original-task",
      );
      expect(preventDefault).toHaveBeenCalledOnce();
      await act(async () => renderer.unmount());
    },
  );
});

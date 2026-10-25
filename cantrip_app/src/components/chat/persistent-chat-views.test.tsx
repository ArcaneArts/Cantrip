import type { ChatSummary } from "@cantrip/protocol";
import { useState } from "react";
import TestRenderer, { act } from "react-test-renderer";
import { expect, it } from "vitest";
import type { IncomingChatView } from "./chat-view-state";
import {
  PersistentChatViews,
  reconcileChatViewOwners,
} from "./persistent-chat-views";

const first = {
  tabId: "a",
  resourceId: "chat-a",
  chat: { id: "chat-a" } as ChatSummary,
};
const second = {
  tabId: "b",
  resourceId: "chat-b",
  chat: { id: "chat-b" } as ChatSummary,
};

it("retains metadata during loading but not after close or resource replacement", () => {
  expect(
    reconcileChatViewOwners([first], [{ tabId: "a", resourceId: "chat-a" }]),
  ).toEqual([first]);
  expect(reconcileChatViewOwners([first], [])).toEqual([]);
  expect(
    reconcileChatViewOwners([first], [{ tabId: "a", resourceId: "other" }])[0]
      ?.chat,
  ).toBeUndefined();
});

function Draft({ id, visible }: { id: string; visible: boolean }) {
  const [draft, setDraft] = useState("");
  return (
    <input
      data-chat={id}
      data-visible={visible}
      value={draft}
      onChange={(event) => setDraft(event.target.value)}
    />
  );
}

it("keeps a staged chat inert until commit and preserves its mounted draft", async () => {
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  const incoming: IncomingChatView = {
    tabId: first.tabId,
    chat: first.chat,
    state: {} as IncomingChatView["state"],
    staging: { onRestored() {}, onError() {} },
  };
  const renderChat = (chat: ChatSummary, _id: string, visible: boolean) => (
    <Draft id={chat.id} visible={visible} />
  );
  let tree!: TestRenderer.ReactTestRenderer;
  try {
    await act(async () => {
      tree = TestRenderer.create(
        <PersistentChatViews
          owners={[]}
          incomingViews={[incoming]}
          selectedTabId="a"
          renderChat={renderChat}
        />,
      );
    });
    const surface = () =>
      tree.root.findByProps({ "data-slot": "persistent-chat-surface" });
    expect(surface().props.inert).toBe(true);
    expect(tree.root.findByType("input").props["data-visible"]).toBe(false);
    await act(async () =>
      tree.root
        .findByType("input")
        .props.onChange({ target: { value: "restored draft" } }),
    );
    await act(async () =>
      tree.update(
        <PersistentChatViews
          owners={[first]}
          incomingViews={[{ ...incoming, staging: undefined }]}
          selectedTabId="a"
          renderChat={renderChat}
        />,
      ),
    );
    expect(surface().props.inert).toBe(false);
    expect(tree.root.findByType("input").props.value).toBe("restored draft");
    expect(tree.root.findByType("input").props["data-visible"]).toBe(true);
    await act(async () =>
      tree.update(
        <PersistentChatViews
          owners={[]}
          incomingViews={[]}
          selectedTabId={null}
          renderChat={renderChat}
        />,
      ),
    );
    expect(tree.root.findAllByType("input")).toHaveLength(0);
  } finally {
    await act(async () => tree?.unmount());
  }
});

it("keeps inactive drafts across selection and releases only the closed tab", async () => {
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  const renderChat = (chat: ChatSummary, _id: string, visible: boolean) => (
    <Draft id={chat.id} visible={visible} />
  );
  let tree!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    tree = TestRenderer.create(
      <PersistentChatViews
        owners={[first, second]}
        selectedTabId="a"
        renderChat={renderChat}
      />,
    );
  });
  const input = () =>
    tree.root
      .findAllByType("input")
      .find((node) => node.props["data-chat"] === "chat-a")!;
  await act(async () => {
    input().props.onChange({ target: { value: "unfinished message" } });
  });
  await act(async () => {
    tree.update(
      <PersistentChatViews
        owners={[first, second]}
        selectedTabId="b"
        renderChat={renderChat}
      />,
    );
  });
  expect(input().props.value).toBe("unfinished message");
  expect(input().props["data-visible"]).toBe(false);
  await act(async () => {
    tree.update(
      <PersistentChatViews
        owners={[first]}
        selectedTabId="a"
        renderChat={renderChat}
      />,
    );
  });
  expect(input().props.value).toBe("unfinished message");
  expect(tree.root.findAllByType("input")).toHaveLength(1);
  await act(async () => {
    tree.unmount();
  });
});

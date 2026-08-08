import { describe, expect, it, vi } from "vitest";

import { RemoteSurfaceRfbChannel } from "./remote-surface-rfb-channel";

describe("RemoteSurfaceRfbChannel", () => {
  it("bridges noVNC byte messages without exposing the relay transport", () => {
    const send = vi.fn((_bytes: Uint8Array) => true);
    const channel = new RemoteSurfaceRfbChannel(send);
    const messages: number[][] = [];
    channel.onmessage = (event) => {
      messages.push([...new Uint8Array(event.data)]);
    };

    channel.send(Uint8Array.from([1, 2, 3]));
    const inbound = Uint8Array.from([4, 5, 6]);
    channel.receive(inbound);
    inbound.fill(9);

    expect(send).toHaveBeenCalledOnce();
    expect([...send.mock.calls[0]![0]]).toEqual([1, 2, 3]);
    expect(messages).toEqual([[4, 5, 6]]);
    expect(channel.readyState).toBe(1);
  });
});

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement } from "react";
import TestRenderer, { act } from "react-test-renderer";
import { describe, expect, it, vi } from "vitest";

import type { WorkerObservationClient } from "./worker-observation-client";
import {
  runningChatWorkerObservationDemands,
  WorkerObservationBackgroundDemandSession,
  WorkerObservationProvider,
} from "./worker-observation-react";

function chat(
  activeWorkerId: string | null,
  status: "idle" | "running" | "waiting-for-approval" | "offline" | "failed",
  experience: "agent" | "task" = "agent",
) {
  return { activeWorkerId, experience, status };
}

describe("runningChatWorkerObservationDemands", () => {
  it("retains only workers serving cached running background chats and Tasks", () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData(
      ["chats", "project-one"],
      [
        chat("worker-one", "running"),
        chat("worker-two", "idle"),
        chat("worker-three", "waiting-for-approval", "task"),
      ],
    );
    queryClient.setQueryData(
      ["chats", "project-two"],
      [chat("worker-one", "running", "task"), chat("worker-four", "offline")],
    );
    queryClient.setQueryData(
      ["standalone-chats"],
      [chat("worker-five", "waiting-for-approval"), chat(null, "running")],
    );

    expect(runningChatWorkerObservationDemands(queryClient)).toEqual([
      { workerId: "worker-five", topics: ["chat-progress"] },
      { workerId: "worker-one", topics: ["chat-progress"] },
      { workerId: "worker-three", topics: ["chat-progress"] },
    ]);
  });

  it("retires workers as canonical chat inventories stop running", () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData(
      ["chats", "project-one"],
      [chat("worker-one", "running")],
    );
    expect(runningChatWorkerObservationDemands(queryClient)).toHaveLength(1);

    queryClient.setQueryData(
      ["chats", "project-one"],
      [chat("worker-one", "idle")],
    );
    expect(runningChatWorkerObservationDemands(queryClient)).toEqual([]);
  });

  it("retains and releases background demand as cached Chat state changes", async () => {
    const queryClient = new QueryClient();
    const release = vi.fn();
    const retainDemands = vi.fn(() => release);
    const client = { retainDemands } as unknown as WorkerObservationClient;
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(
        createElement(
          QueryClientProvider,
          { client: queryClient },
          createElement(
            WorkerObservationProvider,
            { client },
            createElement(WorkerObservationBackgroundDemandSession),
          ),
        ),
      );
    });

    await act(async () => {
      queryClient.setQueryData(
        ["chats", "project-one"],
        [chat("worker-one", "running", "task")],
      );
    });
    expect(retainDemands).toHaveBeenCalledWith([
      { workerId: "worker-one", topics: ["chat-progress"] },
    ]);

    await act(async () => {
      queryClient.setQueryData(
        ["chats", "project-one"],
        [chat("worker-one", "idle", "task")],
      );
    });
    expect(release).toHaveBeenCalledOnce();
    await act(async () => renderer.unmount());
    queryClient.clear();
  });
});

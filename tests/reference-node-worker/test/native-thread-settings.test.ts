import { describe, expect, it } from "vitest";
import { NativeThreadSettingsState } from "../src/codex/native-thread-settings.js";
import { nativeThreadSettings } from "./fixtures/native-thread-settings.js";

const patch = { collaborationMode: nativeThreadSettings().collaborationMode };
const event = (
  operationId?: string,
  submissionId?: string,
  model = "native-choice",
) => ({
  threadId: "root",
  ...(operationId ? { operationId } : {}),
  ...(submissionId ? { submissionId } : {}),
  threadSettings: nativeThreadSettings({ model }),
});

describe("native thread settings evidence", () => {
  it("retains an early rejected request until its outstanding RPC settles", () => {
    const state = new NativeThreadSettingsState();
    const first = state.begin("root", "first", patch);
    state.observeError({
      threadId: "root",
      turnId: "sub-first",
      willRetry: false,
      error: {
        message: "rejected",
        codexErrorInfo: {
          threadSettingsUpdateFailed: { operationId: "first" },
        },
      },
    });
    const second = state.begin("root", "second", patch);
    state.acknowledge("root", first, {
      operationId: "first",
      submissionId: "sub-first",
    });
    state.acknowledge("root", second, {
      operationId: "second",
      submissionId: "sub-second",
    });
    expect(
      state.read("root").requests.map((request) => request.status),
    ).toEqual(["rejected", "queued"]);
    state.begin("root", "third", patch);
    expect(
      state.read("root").requests.map((request) => request.operationId),
    ).toEqual(["second", "third"]);
  });

  it.each(["error-first", "applied-first"])(
    "does not hide contradictory native results: %s",
    (order) => {
      const state = new NativeThreadSettingsState();
      const pending = state.begin("root", "op", patch);
      const reject = () =>
        state.observeError({
          threadId: "root",
          turnId: "sub",
          willRetry: false,
          error: {
            message: "rejected",
            codexErrorInfo: {
              threadSettingsUpdateFailed: { operationId: "op" },
            },
          },
        });
      if (order === "error-first") reject();
      state.observe(event("op", "sub"));
      if (order === "applied-first") reject();
      state.acknowledge("root", pending, {
        operationId: "op",
        submissionId: "sub",
      });
      expect(state.read("root").requests[0]).toMatchObject({
        status: "uncertain",
        error: { message: "rejected" },
        applied: { submissionId: "sub" },
      });
    },
  );

  it("rejects an acknowledgment that contradicts the rejection submission", () => {
    const state = new NativeThreadSettingsState();
    const pending = state.begin("root", "op", patch);
    state.observeError({
      threadId: "root",
      turnId: "sub",
      willRetry: false,
      error: {
        message: "rejected",
        codexErrorInfo: { threadSettingsUpdateFailed: { operationId: "op" } },
      },
    });
    expect(() =>
      state.acknowledge("root", pending, {
        operationId: "op",
        submissionId: "different",
      }),
    ).toThrow("not correlated");
    expect(state.read("root").requests[0]).toMatchObject({
      status: "uncertain",
      submissionId: "sub",
    });
  });

  it("retains an operation-correlated rejection before or without its queue acknowledgment", () => {
    const state = new NativeThreadSettingsState();
    const pending = state.begin("root", "op", patch);
    const error = {
      threadId: "root",
      turnId: "sub",
      willRetry: false,
      error: {
        message: "constraint rejected",
        codexErrorInfo: { threadSettingsUpdateFailed: { operationId: "op" } },
      },
    };
    expect(state.observeError(error)).toBe(true);
    state.failed("root", pending, false);
    expect(state.read("root").requests[0]).toMatchObject({
      submissionId: "sub",
      status: "rejected",
      error: error.error,
    });
    state.acknowledge("root", pending, {
      operationId: "op",
      submissionId: "sub",
    });
    expect(state.read("root").requests[0]).toMatchObject({
      status: "rejected",
      error: error.error,
    });
  });

  it.each(["other", ""])(
    "does not match a different explicit operation by submission ID: %j",
    (operationId) => {
      const state = new NativeThreadSettingsState();
      const pending = state.begin("root", "op", patch);
      state.acknowledge("root", pending, {
        operationId: "op",
        submissionId: "sub",
      });
      expect(
        state.observeError({
          threadId: "root",
          turnId: "sub",
          willRetry: false,
          error: {
            message: "other command",
            codexErrorInfo: {
              threadSettingsUpdateFailed: { operationId },
            },
          },
        }),
      ).toBe(false);
      expect(state.read("root").requests[0]?.status).toBe("queued");
    },
  );

  it.each(["before", "after"])(
    "correlates asynchronous errors %s acknowledgment",
    (order) => {
      const state = new NativeThreadSettingsState();
      state.observe(event());
      const pending = state.begin("root", "op", patch);
      const error = {
        threadId: "root",
        turnId: "sub",
        error: {
          message: "native constraint rejected",
          codexErrorInfo: "badRequest",
        },
        willRetry: false,
      };
      if (order === "before") expect(state.observeError(error)).toBe(false);
      state.acknowledge("root", pending, {
        operationId: "op",
        submissionId: "sub",
      });
      if (order === "after") expect(state.observeError(error)).toBe(true);
      expect(state.read("root").requests[0]).toMatchObject({
        status: "rejected",
        error: error.error,
      });
      expect(state.read("root").confirmed?.settings.model).toBe(
        "native-choice",
      );
    },
  );

  it("does not consume unrelated model or child errors as settings failures", () => {
    const state = new NativeThreadSettingsState();
    const pending = state.begin("root", "op", patch);
    const error = {
      threadId: "root",
      turnId: "model-turn",
      error: { message: "model failed" },
      willRetry: false,
    };
    expect(state.observeError(error)).toBe(false);
    expect(
      state.observeError({ ...error, threadId: "child", turnId: "sub" }),
    ).toBe(false);
    state.acknowledge("root", pending, {
      operationId: "op",
      submissionId: "sub",
    });
    expect(state.read("root").requests[0]?.status).toBe("queued");
  });

  it("retains the complete snapshot and isolates reader mutations", () => {
    const state = new NativeThreadSettingsState();
    const input = event();
    input.threadSettings.futureSetting = { enabled: true };
    state.observe(input);
    const read = state.read("root");
    expect(read.confirmed?.settings).toEqual(input.threadSettings);
    read.confirmed!.settings.sandboxPolicy.type = "externalMutation";
    expect(state.read("root").confirmed?.settings.sandboxPolicy.type).toBe(
      "readOnly",
    );
    expect(state.read("child").confirmed).toBeNull();
  });

  it("keeps queue acknowledgment separate from applied evidence", () => {
    const state = new NativeThreadSettingsState();
    const pending = state.begin("root", "op", patch);
    state.acknowledge("root", pending, {
      operationId: "op",
      submissionId: "sub",
    });
    expect(state.read("root").requests[0]?.status).toBe("queued");
    expect(state.confirmedPlanMode("root")).toBeNull();
    expect(state.selectedPlanMode("root")).toBe("default");
    state.observe(event("op", "sub"));
    expect(state.read("root").requests[0]?.status).toBe("applied");
    expect(state.confirmedPlanMode("root")).toBe("default");
  });

  it("correlates an early event without regressing a later external choice at ack", () => {
    const state = new NativeThreadSettingsState();
    const pending = state.begin("root", "op", patch);
    state.observe(event("op", "sub", "first-choice"));
    state.observe(event(undefined, undefined, "later-choice"));
    state.acknowledge("root", pending, {
      operationId: "op",
      submissionId: "sub",
    });
    expect(state.read("root").confirmed?.settings.model).toBe("later-choice");
    expect(state.read("root").requests[0]?.applied?.settings.model).toBe(
      "first-choice",
    );
  });

  it.each([
    {},
    { operationId: "other", submissionId: "sub" },
    { operationId: "op", submissionId: "wrong" },
  ])("does not treat an unmatched receipt as confirmed: %j", (ack) => {
    const state = new NativeThreadSettingsState();
    const pending = state.begin("root", "op", patch);
    state.observe(event("op", "sub"));
    expect(() => state.acknowledge("root", pending, ack)).toThrow(
      "not correlated",
    );
    expect(state.read("root").requests[0]?.status).toBe("uncertain");
  });

  it("retains successful native evidence after losing the RPC response", () => {
    const state = new NativeThreadSettingsState();
    const pending = state.begin("root", "op", patch);
    state.observe(event("op", "sub"));
    state.failed("root", pending, false);
    expect(state.read("root").requests[0]?.status).toBe("applied");
    expect(state.read("root").confirmed?.submissionId).toBe("sub");
  });

  it("retains prior effective state when a requested change is rejected", () => {
    const state = new NativeThreadSettingsState();
    state.observe(event());
    const pending = state.begin("root", "op", { model: "rejected-choice" });
    state.failed("root", pending, true);
    expect(state.read("root").requests[0]?.status).toBe("rejected");
    expect(state.read("root").confirmed?.settings.model).toBe("native-choice");
  });

  it.each(["forget", "clear"] as const)(
    "rejects stale acknowledgments after %s",
    (reset) => {
      const state = new NativeThreadSettingsState();
      const pending = state.begin("root", "op", patch);
      state.observe(event("op", "sub"));
      state[reset]("root");
      expect(() =>
        state.acknowledge("root", pending, {
          operationId: "op",
          submissionId: "sub",
        }),
      ).toThrow("closed or changed");
      expect(state.read("root")).toEqual({ confirmed: null, requests: [] });
    },
  );

  it("preserves requested tier omission/null/value separately from native normalization", () => {
    const state = new NativeThreadSettingsState();
    const patches = [{}, { serviceTier: null }, { serviceTier: "priority" }];
    patches.forEach((value, index) =>
      state.begin("root", `op-${index}`, value),
    );
    state.observe({
      ...event(),
      threadSettings: nativeThreadSettings({ serviceTier: "default" }),
    });
    expect(state.read("root").requests.map((request) => request.patch)).toEqual(
      patches,
    );
    expect(state.read("root").confirmed?.settings.serviceTier).toBe("default");
  });

  it("rejects incomplete notifications without overwriting prior evidence", () => {
    const state = new NativeThreadSettingsState();
    state.observe(event());
    expect(() =>
      state.observe({ threadId: "root", threadSettings: { model: "partial" } }),
    ).toThrow();
    expect(state.read("root").confirmed?.settings.model).toBe("native-choice");
  });
});

describe("versioned native settings snapshots", () => {
  const sample = (
    revision: string,
    model = "native-choice",
    epoch = "core-one",
  ) => ({
    ...event(),
    threadSettings: {
      ...nativeThreadSettings({ model }),
      settingsVersion: { epoch, revision },
    },
  });
  it("retains newer live state when an earlier read returns after its notification", () => {
    const state = new NativeThreadSettingsState();
    state.observe(sample("9007199254740993", "new-choice"));
    state.observe(sample("9007199254740992", "old-choice"));
    expect(state.read("root").confirmed?.settings.model).toBe("new-choice");
    state.observe(event(undefined, undefined, "unversioned-old-choice"));
    expect(state.read("root").confirmed?.settings.model).toBe("new-choice");
  });
  it("keeps stale operation evidence without regressing the current selection", () => {
    const state = new NativeThreadSettingsState();
    const request = state.begin("root", "old", { model: "old-choice" });
    state.observe(sample("2", "new-choice"));
    state.observe({
      ...sample("1", "old-choice"),
      operationId: "old",
      submissionId: "submission",
    });
    state.acknowledge("root", request, {
      operationId: "old",
      submissionId: "submission",
    });
    expect(state.read("root").requests[0]?.status).toBe("applied");
    expect(state.read("root").requests[0]?.applied?.settings.model).toBe(
      "old-choice",
    );
    expect(state.read("root").confirmed?.settings.model).toBe("new-choice");
  });
  it("accepts repeated equal versions but rejects contradictory snapshots and malformed counters", () => {
    const state = new NativeThreadSettingsState();
    state.observe(sample("1"));
    state.observe(sample("1"));
    expect(() => state.observe(sample("1", "conflicting-choice"))).toThrow(
      "reused",
    );
    for (const revision of ["-1", "1.5", "01", "18446744073709551616"])
      expect(() => state.observe(sample(revision))).toThrow();
    expect(state.read("root").confirmed?.settings.model).toBe("native-choice");
  });
  it("starts a separate epoch only after the old thread observation is retired", () => {
    const state = new NativeThreadSettingsState();
    state.observe(sample("12"));
    expect(() =>
      state.observe(sample("0", "recovered-choice", "core-two")),
    ).toThrow("epoch");
    state.forget("root");
    state.observe(sample("0", "recovered-choice", "core-two"));
    expect(state.read("root").confirmed?.settings.model).toBe(
      "recovered-choice",
    );
  });
});

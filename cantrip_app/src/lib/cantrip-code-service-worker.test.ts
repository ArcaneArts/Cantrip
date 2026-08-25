import { afterEach, describe, expect, it, vi } from "vitest";

import serviceWorkerSource from "../../public/cantrip-code-service-worker.js?raw";

const ADAPTER_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_ADAPTER_ID = "22222222-2222-4222-8222-222222222222";
const MAX_CONCURRENT_REQUESTS = 32;
const MAX_REQUEST_BYTES = 16 * 1_024 * 1_024;
const MAX_RESPONSE_BYTES = 64 * 1_024 * 1_024;
const MAX_HEADER_BYTES = 64 * 1_024;
const MAX_HEADER_COUNT = 256;
const REQUEST_DEADLINE_MS = 30_000;

interface TestRequest {
  arrayBuffer?: () => Promise<ArrayBuffer>;
  body: ReadableStream<Uint8Array> | null;
  headers: Headers;
  method: string;
  signal: AbortSignal;
  url: string;
}

interface ChannelMessage {
  adapterId?: string;
  body?: unknown;
  error?: unknown;
  headers?: unknown;
  method?: string;
  requestId?: string;
  status?: number;
  statusText?: string;
  type?: string;
  url?: string;
}

class FakeBroadcastChannel extends EventTarget {
  static readonly instances: FakeBroadcastChannel[] = [];
  readonly messages: ChannelMessage[] = [];

  constructor(readonly name: string) {
    super();
    FakeBroadcastChannel.instances.push(this);
  }

  postMessage(message: ChannelMessage): void {
    this.messages.push(message);
  }

  receive(message: ChannelMessage): void {
    const event = new Event("message");
    Object.defineProperty(event, "data", { value: message });
    this.dispatchEvent(event);
  }
}

function testRequest(
  options: Partial<TestRequest> & Pick<TestRequest, "method"> = {
    method: "GET",
  },
): TestRequest {
  return {
    body: null,
    headers: new Headers(),
    signal: new AbortController().signal,
    url: `https://cantrip.example/__cantrip_code/${ADAPTER_ID}/code/`,
    ...options,
  };
}

function createHarness(): {
  channel: FakeBroadcastChannel;
  dispatch: (request: TestRequest) => Promise<Response>;
  requests: () => ChannelMessage[];
} {
  FakeBroadcastChannel.instances.length = 0;
  const worker = new EventTarget() as EventTarget & {
    clients: { claim(): Promise<void> };
    skipWaiting(): Promise<void>;
  };
  worker.clients = { claim: async () => undefined };
  worker.skipWaiting = async () => undefined;
  let requestSequence = 0;
  vi.stubGlobal("self", worker);
  vi.stubGlobal("BroadcastChannel", FakeBroadcastChannel);
  vi.stubGlobal("crypto", {
    randomUUID: () =>
      `33333333-3333-4333-8333-${String(++requestSequence).padStart(12, "0")}`,
  });
  new Function(serviceWorkerSource)();
  const channel = FakeBroadcastChannel.instances[0];
  if (!channel) throw new Error("Service worker did not open its channel.");
  return {
    channel,
    dispatch: (request) => {
      let response: Promise<Response> | undefined;
      const event = new Event("fetch");
      Object.defineProperties(event, {
        request: { value: request },
        respondWith: {
          value: (value: Promise<Response> | Response) => {
            response = Promise.resolve(value);
          },
        },
      });
      worker.dispatchEvent(event);
      if (!response) throw new Error("Service worker ignored a Code request.");
      return response;
    },
    requests: () =>
      channel.messages.filter(
        ({ type }) => type === "cantrip-code-http-request-v1",
      ),
  };
}

function respond(
  harness: ReturnType<typeof createHarness>,
  request: ChannelMessage,
  adapterId = ADAPTER_ID,
): void {
  harness.channel.receive({
    adapterId,
    body: new TextEncoder().encode("ok").buffer,
    headers: [["content-type", "text/plain"]],
    requestId: request.requestId,
    status: 200,
    statusText: "OK",
    type: "cantrip-code-http-response-v1",
  });
}

async function respondWith(
  message: Omit<ChannelMessage, "adapterId" | "requestId" | "type">,
): Promise<Response> {
  const harness = createHarness();
  const responsePromise = harness.dispatch(testRequest());
  await vi.waitFor(() => expect(harness.requests()).toHaveLength(1));
  harness.channel.receive({
    adapterId: ADAPTER_ID,
    requestId: harness.requests()[0]?.requestId,
    type: "cantrip-code-http-response-v1",
    ...message,
  });
  return responsePromise;
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("Cantrip Code service worker", () => {
  it("preserves normal requests and ignores a response from another adapter", async () => {
    const harness = createHarness();
    const responsePromise = harness.dispatch(testRequest());
    await vi.waitFor(() => expect(harness.requests()).toHaveLength(1));
    let settled = false;
    void responsePromise.then(() => {
      settled = true;
    });

    respond(harness, harness.requests()[0]!, OTHER_ADAPTER_ID);
    await Promise.resolve();
    expect(settled).toBe(false);
    respond(harness, harness.requests()[0]!);

    const response = await responsePromise;
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("ok");
  });

  it("rejects a lengthless streaming body as soon as it exceeds 16 MiB", async () => {
    const harness = createHarness();
    const chunk = new Uint8Array(1 * 1_024 * 1_024);
    let pulls = 0;
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1;
        controller.enqueue(chunk);
      },
      cancel,
    });

    const response = await harness.dispatch(
      testRequest({
        arrayBuffer: async () => {
          throw new Error("The full body must not be allocated.");
        },
        body,
        method: "POST",
      }),
    );

    expect(response.status).toBe(413);
    expect(pulls).toBe(17);
    expect(cancel).toHaveBeenCalledOnce();
    expect(harness.requests()).toHaveLength(0);
    expect(await response.text()).toMatch(/too large/iu);
  });

  it("enforces one absolute deadline across streaming ingress and page delivery", async () => {
    vi.useFakeTimers();
    const harness = createHarness();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        setTimeout(() => {
          controller.enqueue(new Uint8Array([1]));
          controller.close();
        }, 20_000);
      },
    });
    const responsePromise = harness.dispatch(
      testRequest({
        arrayBuffer: () =>
          new Promise((resolve) => {
            setTimeout(() => resolve(new Uint8Array([1]).buffer), 20_000);
          }),
        body,
        method: "POST",
      }),
    );
    let response: Response | null = null;
    void responsePromise.then((value) => {
      response = value;
    });

    await vi.advanceTimersByTimeAsync(20_000);
    expect(harness.requests()).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(10_000);
    expect.soft(response).not.toBeNull();
    if (!response) await vi.advanceTimersByTimeAsync(20_000);

    expect((await responsePromise).status).toBe(504);
    expect(
      harness.channel.messages.filter(
        ({ type }) => type === "cantrip-code-http-cancel-v1",
      ),
    ).toHaveLength(1);
  });

  it("bounds concurrent ingress and releases a slot after settlement", async () => {
    const harness = createHarness();
    const pending = Array.from({ length: MAX_CONCURRENT_REQUESTS }, () =>
      harness.dispatch(testRequest()),
    );
    const overflowCancel = vi.fn(() => new Promise<void>(() => undefined));
    const overflow = harness.dispatch(
      testRequest({
        body: new ReadableStream<Uint8Array>({ cancel: overflowCancel }),
        method: "POST",
      }),
    );
    let overflowResponse: Response | null = null;
    void overflow.then((response) => {
      overflowResponse = response;
    });
    await vi.waitFor(() =>
      expect(harness.requests().length).toBeGreaterThanOrEqual(
        MAX_CONCURRENT_REQUESTS,
      ),
    );
    await Promise.resolve();

    expect.soft(harness.requests()).toHaveLength(MAX_CONCURRENT_REQUESTS);
    expect.soft(overflowResponse).not.toBeNull();
    expect(overflowCancel).toHaveBeenCalledOnce();
    for (const request of harness.requests()) respond(harness, request);
    const responses = await Promise.all([...pending, overflow]);
    expect(responses.at(-1)?.status).toBe(429);

    const afterSettlement = harness.dispatch(testRequest());
    await vi.waitFor(() =>
      expect(harness.requests()).toHaveLength(MAX_CONCURRENT_REQUESTS + 1),
    );
    respond(harness, harness.requests().at(-1)!);
    await expect(afterSettlement).resolves.toMatchObject({ status: 200 });
  });

  it("propagates request cancellation to the page exactly once", async () => {
    vi.useFakeTimers();
    const harness = createHarness();
    const controller = new AbortController();
    const responsePromise = harness.dispatch(
      testRequest({ method: "GET", signal: controller.signal }),
    );
    await vi.waitFor(() => expect(harness.requests()).toHaveLength(1));

    controller.abort();
    controller.abort();
    await vi.advanceTimersByTimeAsync(REQUEST_DEADLINE_MS * 2);

    expect((await responsePromise).status).toBe(502);
    expect(
      harness.channel.messages.filter(
        ({ type }) => type === "cantrip-code-http-cancel-v1",
      ),
    ).toHaveLength(1);
  });

  it("preserves an exact page-side failure as an HTTP 502 response", async () => {
    const response = await respondWith({ error: "upstream failure" });

    expect(response.status).toBe(502);
    expect(await response.text()).toBe("upstream failure");
  });

  it.each([
    {
      name: "missing status",
      response: {
        body: new ArrayBuffer(0),
        headers: [],
        statusText: "OK",
      },
    },
    {
      name: "fractional status",
      response: {
        body: new ArrayBuffer(0),
        headers: [],
        status: 200.5,
        statusText: "OK",
      },
    },
    {
      name: "status below the Response range",
      response: {
        body: new ArrayBuffer(0),
        headers: [],
        status: 199,
        statusText: "Informational",
      },
    },
    {
      name: "status above the Response range",
      response: {
        body: new ArrayBuffer(0),
        headers: [],
        status: 600,
        statusText: "Invalid",
      },
    },
    {
      name: "non-iterable headers",
      response: {
        body: new ArrayBuffer(0),
        headers: { "x-test": "value" },
        status: 200,
        statusText: "OK",
      },
    },
    {
      name: "non-string header value",
      response: {
        body: new ArrayBuffer(0),
        headers: [["x-test", 42]],
        status: 200,
        statusText: "OK",
      },
    },
    {
      name: "too many headers",
      response: {
        body: new ArrayBuffer(0),
        headers: Array.from({ length: MAX_HEADER_COUNT + 1 }, (_, index) => [
          `x-test-${index}`,
          "value",
        ]),
        status: 200,
        statusText: "OK",
      },
    },
    {
      name: "oversized header block",
      response: {
        body: new ArrayBuffer(0),
        headers: [["x-test", "x".repeat(MAX_HEADER_BYTES)]],
        status: 200,
        statusText: "OK",
      },
    },
  ])(
    "rejects malformed page response metadata: $name",
    async ({ response }) => {
      await expect(respondWith(response)).resolves.toMatchObject({
        status: 502,
      });
    },
  );

  it.each([
    { body: "not an ArrayBuffer", name: "non-ArrayBuffer body" },
    {
      body: new ArrayBuffer(MAX_RESPONSE_BYTES + 1),
      name: "oversized body",
    },
  ])("rejects a $name", async ({ body }) => {
    await expect(
      respondWith({ body, headers: [], status: 200, statusText: "OK" }),
    ).resolves.toMatchObject({ status: 502 });
  });
});

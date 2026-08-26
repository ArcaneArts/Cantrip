import { afterEach, describe, expect, it, vi } from "vitest";

import serviceWorkerSource from "../../public/cantrip-code-service-worker.js?raw";

const ADAPTER_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_ADAPTER_ID = "22222222-2222-4222-8222-222222222222";
const THIRD_ADAPTER_ID = "44444444-4444-4444-8444-444444444444";
const GENERATION = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OTHER_GENERATION = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const FRAME_NONCE = "service_worker_frame_nonce_1234";
const ROOT_LEASE = "service_worker_root_lease_1234";
const LINEAGE_TOKEN = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const ADAPTER_FINGERPRINT = "vXZipe60FhTnINR3q_yyJy4ZqKcKk7fjvIVg1ErTJuk";
const MAX_CONCURRENT_REQUESTS = 32;
const MAX_CONCURRENT_ADAPTER_REQUESTS = 24;
const MAX_RESPONSE_BYTES = 64 * 1_024 * 1_024;
const MAX_HEADER_BYTES = 64 * 1_024;
const MAX_HEADER_COUNT = 256;
const ADAPTER_RECOVERY_TIMEOUT_MS = 1_500;
const REQUEST_DEADLINE_MS = 30_000;
const ORIGIN = "https://cantrip.example";

interface TestRequest {
  body: ReadableStream<Uint8Array> | null;
  headers: Headers;
  method: string;
  mode: RequestMode;
  signal: AbortSignal;
  url: string;
}

interface ChannelMessage {
  adapterId?: string;
  adapterFingerprint?: string;
  body?: unknown;
  challenge?: string;
  error?: unknown;
  frameNonce?: string;
  generation?: string;
  headers?: unknown;
  method?: string;
  lineageToken?: string;
  rootLease?: string;
  reason?: string;
  requestId?: string;
  status?: number;
  statusText?: string;
  type?: string;
  url?: string;
  version?: number;
}

interface TestClient {
  frameType?: "nested" | "top-level";
  id: string;
  messages: ChannelMessage[];
  postMessage(message: ChannelMessage): void;
  type: "sharedworker" | "window" | "worker";
  url: string;
}

class FakeMessagePort extends EventTarget {
  closed = false;
  peer: FakeMessagePort | null = null;
  readonly received: ChannelMessage[] = [];
  started = false;

  close(): void {
    this.closed = true;
  }

  postMessage(message: ChannelMessage): void {
    if (this.closed || !this.peer || this.peer.closed) return;
    this.peer.received.push(message);
    const event = new Event("message");
    Object.defineProperty(event, "data", { value: message });
    this.peer.dispatchEvent(event);
  }

  start(): void {
    this.started = true;
  }
}

interface TestAdapter {
  adapterId: string;
  generation: string;
  pagePort: FakeMessagePort;
  rootLease: string;
  source: TestClient;
  workerPort: FakeMessagePort;
}

interface FetchOptions {
  clientId?: string;
  replacesClientId?: string;
  resultingClientId?: string;
}

function messagePortPair(): {
  pagePort: FakeMessagePort;
  workerPort: FakeMessagePort;
} {
  const pagePort = new FakeMessagePort();
  const workerPort = new FakeMessagePort();
  pagePort.peer = workerPort;
  workerPort.peer = pagePort;
  return { pagePort, workerPort };
}

function topLevelClient(
  id: string,
  url = `${ORIGIN}/projects/project-one`,
): TestClient {
  const messages: ChannelMessage[] = [];
  return {
    frameType: "top-level",
    id,
    messages,
    postMessage: (message) => messages.push(message),
    type: "window",
    url,
  };
}

function testRequest(
  options: Partial<TestRequest> & Pick<TestRequest, "method"> = {
    method: "GET",
  },
  adapterId = ADAPTER_ID,
): TestRequest {
  return {
    body: null,
    headers: new Headers(),
    mode: "same-origin",
    signal: new AbortController().signal,
    url: `${ORIGIN}/__cantrip_code/${adapterId}/code/`,
    ...options,
  };
}

function navigationRequest(
  frameNonce = FRAME_NONCE,
  rootLease = ROOT_LEASE,
): TestRequest {
  return testRequest({
    method: "GET",
    mode: "navigate",
    url: `${ORIGIN}/__cantrip_code/${ADAPTER_ID}/code/?cantripFrameNonce=${frameNonce}&cantripRootLease=${rootLease}`,
  });
}

function clientRegistrationRequest(
  lineage: { frameNonce: string; lineageToken: string },
  generation = GENERATION,
): TestRequest {
  return testRequest({
    headers: new Headers({
      "x-cantrip-code-frame-nonce": lineage.frameNonce,
      "x-cantrip-code-generation": generation,
      "x-cantrip-code-lineage-token": lineage.lineageToken,
    }),
    method: "POST",
    url: `${ORIGIN}/__cantrip_code/${ADAPTER_ID}/code/__cantrip_client_register_v2`,
  });
}

function createHarness(options: { registerDefault?: boolean } = {}): {
  adapter: TestAdapter | null;
  addClient: (client: TestClient) => void;
  bindFrame: (adapter: TestAdapter, frameNonce: string) => void;
  clientMatchAll: ReturnType<typeof vi.fn>;
  clientGet: ReturnType<typeof vi.fn>;
  dispatch: (request: TestRequest, options?: FetchOptions) => Promise<Response>;
  messages: (adapter?: TestAdapter | null) => ChannelMessage[];
  owner: TestClient;
  probe: (source?: TestClient) => ChannelMessage[];
  registerBlobClient: (
    adapter: TestAdapter,
    source: TestClient,
    lineage: { frameNonce: string; lineageToken: string },
  ) => Promise<ChannelMessage[]>;
  register: (
    adapterId: string,
    generation?: string,
    source?: TestClient,
    lineage?: { frameNonce: string; lineageToken: string },
  ) => TestAdapter;
  respondClientChallenge: (
    client: TestClient,
    adapter: TestAdapter,
    lineage: { frameNonce: string; lineageToken: string },
  ) => void;
  removeClient: (clientId: string) => void;
  requests: (adapter?: TestAdapter | null) => ChannelMessage[];
  unregister: (adapter: TestAdapter, generation?: string) => void;
  unregisterFromClient: (
    adapter: TestAdapter,
    source?: TestClient,
    generation?: string,
  ) => void;
} {
  const owner = topLevelClient("owner-client");
  const clientsById = new Map<string, TestClient>([[owner.id, owner]]);
  const clientMatchAll = vi.fn(async () => [owner]);
  const clientGet = vi.fn(async (id: string) => clientsById.get(id));
  const worker = new EventTarget() as EventTarget & {
    clients: {
      claim(): Promise<void>;
      get(id: string): Promise<TestClient | undefined>;
      matchAll(): Promise<TestClient[]>;
    };
    location: { origin: string };
    skipWaiting(): Promise<void>;
  };
  worker.clients = {
    claim: async () => undefined,
    get: clientGet,
    matchAll: clientMatchAll,
  };
  worker.location = { origin: ORIGIN };
  worker.skipWaiting = async () => undefined;
  let requestSequence = 0;
  const subtle = globalThis.crypto.subtle;
  vi.stubGlobal("self", worker);
  vi.stubGlobal("crypto", {
    randomUUID: () =>
      `33333333-3333-4333-8333-${String(++requestSequence).padStart(12, "0")}`,
    subtle,
  });
  new Function(serviceWorkerSource)();

  const dispatchMessage = (
    data: ChannelMessage,
    source: TestClient,
    ports: FakeMessagePort[] = [],
  ): void => {
    const event = new Event("message");
    Object.defineProperties(event, {
      data: { value: data },
      ports: { value: ports },
      source: { value: source },
    });
    worker.dispatchEvent(event);
  };
  const register = (
    adapterId: string,
    generation = GENERATION,
    source = owner,
    lineage?: { frameNonce: string; lineageToken: string },
  ): TestAdapter => {
    const { pagePort, workerPort } = messagePortPair();
    dispatchMessage(
      {
        adapterId,
        generation,
        rootLease: ROOT_LEASE,
        ...lineage,
        type: "cantrip-code-adapter-register-v2",
      },
      source,
      [workerPort],
    );
    const registered = {
      adapterId,
      generation,
      pagePort,
      rootLease: ROOT_LEASE,
      source,
      workerPort,
    };
    pagePort.postMessage({
      adapterId,
      frameNonce: lineage?.frameNonce ?? FRAME_NONCE,
      generation,
      type: "cantrip-code-adapter-frame-bound-v2",
    });
    return registered;
  };
  const adapter =
    options.registerDefault === false
      ? null
      : register(ADAPTER_ID, GENERATION, owner);
  const messages = (selected = adapter): ChannelMessage[] =>
    selected?.pagePort.received ?? [];
  return {
    adapter,
    addClient: (client) => clientsById.set(client.id, client),
    bindFrame: (selected, frameNonce) =>
      selected.pagePort.postMessage({
        adapterId: selected.adapterId,
        frameNonce,
        generation: selected.generation,
        type: "cantrip-code-adapter-frame-bound-v2",
      }),
    clientMatchAll,
    clientGet,
    dispatch: (request, fetchOptions = {}) => {
      let response: Promise<Response> | undefined;
      const event = new Event("fetch");
      Object.defineProperties(event, {
        clientId: { value: fetchOptions.clientId ?? owner.id },
        replacesClientId: { value: fetchOptions.replacesClientId ?? "" },
        request: { value: request },
        respondWith: {
          value: (value: Promise<Response> | Response) => {
            response = Promise.resolve(value);
          },
        },
        resultingClientId: { value: fetchOptions.resultingClientId ?? "" },
      });
      worker.dispatchEvent(event);
      if (!response) throw new Error("Service worker ignored a Code request.");
      return response;
    },
    messages,
    owner,
    probe: (source = owner) => {
      const { pagePort, workerPort } = messagePortPair();
      dispatchMessage(
        { type: "cantrip-code-adapter-protocol-probe-v2" },
        source,
        [workerPort],
      );
      return pagePort.received;
    },
    registerBlobClient: async (selected, source, lineage) => {
      clientsById.set(source.id, source);
      const { pagePort, workerPort } = messagePortPair();
      dispatchMessage(
        {
          adapterId: selected.adapterId,
          generation: selected.generation,
          ...lineage,
          type: "cantrip-code-blob-client-register-v2",
        },
        source,
        [workerPort],
      );
      await vi.waitFor(() => expect(pagePort.received).toHaveLength(1));
      return pagePort.received;
    },
    register,
    respondClientChallenge: (client, selected, lineage) => {
      const challenge = client.messages
        .filter(
          ({ type }) => type === "cantrip-code-client-lineage-challenge-v2",
        )
        .at(-1);
      if (typeof challenge?.challenge !== "string") {
        throw new Error("Client lineage challenge was not delivered.");
      }
      dispatchMessage(
        {
          adapterId: selected.adapterId,
          challenge: challenge.challenge,
          frameNonce: lineage.frameNonce,
          generation: selected.generation,
          lineageToken: lineage.lineageToken,
          type: "cantrip-code-client-lineage-response-v2",
        },
        client,
      );
    },
    removeClient: (clientId) => clientsById.delete(clientId),
    requests: (selected = adapter) =>
      messages(selected).filter(
        ({ type }) => type === "cantrip-code-http-request-v1",
      ),
    unregister: (selected, generation = selected.generation) =>
      selected.pagePort.postMessage({
        adapterId: selected.adapterId,
        generation,
        type: "cantrip-code-adapter-unregister-v2",
      }),
    unregisterFromClient: (
      selected,
      source = selected.source,
      generation = selected.generation,
    ) =>
      dispatchMessage(
        {
          adapterId: selected.adapterId,
          generation,
          type: "cantrip-code-adapter-unregister-v2",
        },
        source,
      ),
  };
}

function requiredAdapter(
  harness: ReturnType<typeof createHarness>,
): TestAdapter {
  if (!harness.adapter) throw new Error("Harness has no default adapter.");
  return harness.adapter;
}

function respond(
  harness: ReturnType<typeof createHarness>,
  request: ChannelMessage,
  adapter = requiredAdapter(harness),
  adapterId = adapter.adapterId,
): void {
  adapter.pagePort.postMessage({
    adapterId,
    body: new TextEncoder().encode("ok").buffer,
    headers: [["content-type", "text/plain"]],
    requestId: request.requestId,
    status: 200,
    statusText: "OK",
    type: "cantrip-code-http-response-v1",
  });
}

function respondHtml(
  harness: ReturnType<typeof createHarness>,
  request: ChannelMessage,
  adapter = requiredAdapter(harness),
): void {
  adapter.pagePort.postMessage({
    adapterId: adapter.adapterId,
    body: new TextEncoder().encode("<html><head></head><body></body></html>")
      .buffer,
    headers: [["content-type", "text/html"]],
    requestId: request.requestId,
    status: 200,
    statusText: "OK",
    type: "cantrip-code-http-response-v1",
  });
}

function responseLineage(html: string): {
  frameNonce: string;
  generation: string;
  lineageToken: string;
} {
  const content =
    /<meta name="cantrip-code-worker-lineage" content="([^"]+)">/u.exec(
      html,
    )?.[1];
  const [generation, frameNonce, lineageToken] = content?.split(":") ?? [];
  if (!generation || !frameNonce || !lineageToken) {
    throw new Error("Protected Code response lineage was missing.");
  }
  return { frameNonce, generation, lineageToken };
}

function blobWorkerClient(id: string): TestClient {
  return {
    id,
    messages: [],
    postMessage: () => undefined,
    type: "worker",
    url: `blob:${ORIGIN}/${id}`,
  };
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((nextResolve) => {
    resolve = nextResolve;
  });
  return { promise, resolve };
}

async function respondWith(
  message: Omit<ChannelMessage, "adapterId" | "requestId" | "type">,
): Promise<Response> {
  const harness = createHarness();
  const adapter = requiredAdapter(harness);
  const responsePromise = harness.dispatch(testRequest());
  await vi.waitFor(() => expect(harness.requests()).toHaveLength(1));
  adapter.pagePort.postMessage({
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
  it("advertises adapter protocol v2 only to an eligible top-level client", () => {
    const harness = createHarness({ registerDefault: false });

    expect(harness.probe()).toEqual([
      {
        type: "cantrip-code-adapter-protocol-ready-v2",
        version: 2,
      },
    ]);
    expect(
      harness.probe({
        ...topLevelClient("nested-client"),
        frameType: "nested",
      }),
    ).toEqual([]);
  });

  it("registers an exact adapter generation through a private MessagePort", () => {
    const harness = createHarness();
    const adapter = requiredAdapter(harness);

    expect(adapter.workerPort.started).toBe(true);
    expect(harness.messages()).toEqual([
      {
        adapterId: ADAPTER_ID,
        generation: GENERATION,
        type: "cantrip-code-adapter-registered-v2",
      },
    ]);
  });

  it("fails closed when no adapter generation is registered", async () => {
    vi.useFakeTimers();
    const harness = createHarness({ registerDefault: false });
    const responsePromise = harness.dispatch(testRequest());

    await vi.advanceTimersByTimeAsync(ADAPTER_RECOVERY_TIMEOUT_MS);
    const response = await responsePromise;

    expect(response.status).toBe(503);
    expect(await response.text()).toMatch(/unavailable/iu);
  });

  it("does not broadcast recovery for an unknown requesting client", async () => {
    const harness = createHarness({ registerDefault: false });

    const response = await harness.dispatch(testRequest(), {
      clientId: "unknown-client",
    });

    expect(response.status).toBe(403);
    expect(harness.owner.messages).toHaveLength(0);
    expect(harness.clientMatchAll).not.toHaveBeenCalled();
  });

  it("recovers an exact adapter after service-worker registry loss", async () => {
    const harness = createHarness({ registerDefault: false });
    const existingFrame = {
      ...topLevelClient(
        "existing-code-frame",
        `${ORIGIN}/__cantrip_code/${ADAPTER_ID}/code/`,
      ),
      frameType: "nested",
    } as const;
    harness.addClient(existingFrame);
    const responsePromise = harness.dispatch(testRequest(), {
      clientId: "existing-code-frame",
    });
    await vi.waitFor(() =>
      expect(harness.owner.messages).toEqual([
        {
          adapterFingerprint: ADAPTER_FINGERPRINT,
          type: "cantrip-code-adapter-registration-required-v2",
        },
      ]),
    );
    expect(harness.owner.messages[0]).not.toHaveProperty("adapterId");

    const lineage = { frameNonce: FRAME_NONCE, lineageToken: LINEAGE_TOKEN };
    const recovered = harness.register(
      ADAPTER_ID,
      GENERATION,
      harness.owner,
      lineage,
    );
    await vi.waitFor(() =>
      expect(existingFrame.messages).toEqual([
        expect.objectContaining({
          type: "cantrip-code-client-lineage-challenge-v2",
        }),
      ]),
    );
    harness.respondClientChallenge(existingFrame, recovered, lineage);
    await vi.waitFor(() => expect(harness.requests(recovered)).toHaveLength(1));
    respond(harness, harness.requests(recovered)[0]!, recovered);

    await expect(responsePromise).resolves.toMatchObject({ status: 200 });
    const sibling = await harness.dispatch(testRequest(), {
      clientId: "different-code-frame",
    });
    expect(sibling.status).toBe(403);
  });

  it("coalesces concurrent recovery challenges for the same exact client", async () => {
    const harness = createHarness({ registerDefault: false });
    const existingFrame = {
      ...topLevelClient(
        "concurrent-recovery-frame",
        `${ORIGIN}/__cantrip_code/${ADAPTER_ID}/code/`,
      ),
      frameType: "nested",
    } as const;
    harness.addClient(existingFrame);

    const firstResponse = harness.dispatch(testRequest(), {
      clientId: existingFrame.id,
    });
    const secondResponse = harness.dispatch(testRequest(), {
      clientId: existingFrame.id,
    });
    await vi.waitFor(() => expect(harness.owner.messages).toHaveLength(1));

    const lineage = { frameNonce: FRAME_NONCE, lineageToken: LINEAGE_TOKEN };
    const recovered = harness.register(
      ADAPTER_ID,
      GENERATION,
      harness.owner,
      lineage,
    );
    await vi.waitFor(() =>
      expect(
        existingFrame.messages.filter(
          ({ type }) => type === "cantrip-code-client-lineage-challenge-v2",
        ),
      ).toHaveLength(1),
    );
    harness.respondClientChallenge(existingFrame, recovered, lineage);
    await vi.waitFor(() => expect(harness.requests(recovered)).toHaveLength(2));
    for (const request of harness.requests(recovered)) {
      respond(harness, request, recovered);
    }

    await expect(Promise.all([firstResponse, secondResponse])).resolves.toEqual(
      [
        expect.objectContaining({ status: 200 }),
        expect.objectContaining({ status: 200 }),
      ],
    );
  });

  it("settles a pending recovery challenge when the frame epoch changes", async () => {
    const harness = createHarness({ registerDefault: false });
    const existingFrame = {
      ...topLevelClient(
        "superseded-recovery-frame",
        `${ORIGIN}/__cantrip_code/${ADAPTER_ID}/code/`,
      ),
      frameType: "nested",
    } as const;
    harness.addClient(existingFrame);
    const responsePromise = harness.dispatch(testRequest(), {
      clientId: existingFrame.id,
    });
    await vi.waitFor(() => expect(harness.owner.messages).toHaveLength(1));

    const recovered = harness.register(ADAPTER_ID, GENERATION, harness.owner, {
      frameNonce: FRAME_NONCE,
      lineageToken: LINEAGE_TOKEN,
    });
    await vi.waitFor(() =>
      expect(
        existingFrame.messages.filter(
          ({ type }) => type === "cantrip-code-client-lineage-challenge-v2",
        ),
      ).toHaveLength(1),
    );
    let status: number | null = null;
    void responsePromise.then((response) => {
      status = response.status;
    });

    harness.bindFrame(recovered, "superseding_frame_nonce_1234");
    for (let index = 0; index < 10 && status === null; index += 1) {
      await Promise.resolve();
    }

    expect(status).toBe(403);
    expect(harness.requests(recovered)).toHaveLength(0);
  });

  it("recovers an exact adapter for an already-owned worker client", async () => {
    const harness = createHarness({ registerDefault: false });
    const existingWorker = {
      ...topLevelClient(
        "existing-code-worker",
        `${ORIGIN}/__cantrip_code/${ADAPTER_ID}/code/worker.js`,
      ),
      frameType: undefined,
      type: "worker",
    } as const;
    harness.addClient(existingWorker);
    const responsePromise = harness.dispatch(testRequest(), {
      clientId: "existing-code-worker",
    });
    await vi.waitFor(() => expect(harness.owner.messages).toHaveLength(1));

    const lineage = { frameNonce: FRAME_NONCE, lineageToken: LINEAGE_TOKEN };
    const recovered = harness.register(
      ADAPTER_ID,
      GENERATION,
      harness.owner,
      lineage,
    );
    await vi.waitFor(() =>
      expect(existingWorker.messages).toEqual([
        expect.objectContaining({
          type: "cantrip-code-client-lineage-challenge-v2",
        }),
      ]),
    );
    harness.respondClientChallenge(existingWorker, recovered, lineage);
    await vi.waitFor(() => expect(harness.requests(recovered)).toHaveLength(1));
    respond(harness, harness.requests(recovered)[0]!, recovered);

    await expect(responsePromise).resolves.toMatchObject({ status: 200 });
  });

  it("restores exact blob-worker lineage when the adapter registry restarts", async () => {
    const harness = createHarness({ registerDefault: false });
    const lineage = {
      frameNonce: FRAME_NONCE,
      lineageToken: LINEAGE_TOKEN,
    };
    const recovered = harness.register(
      ADAPTER_ID,
      GENERATION,
      harness.owner,
      lineage,
    );
    const client = blobWorkerClient("recovered-blob-worker");

    await expect(
      harness.registerBlobClient(recovered, client, lineage),
    ).resolves.toMatchObject([
      { type: "cantrip-code-blob-client-registered-v2" },
    ]);

    const response = harness.dispatch(testRequest(), { clientId: client.id });
    await vi.waitFor(() => expect(harness.requests(recovered)).toHaveLength(1));
    respond(harness, harness.requests(recovered)[0]!, recovered);
    await expect(response).resolves.toMatchObject({ status: 200 });
  });

  it("lets an exact blob worker trigger owner recovery without treating its adapter UUID as authority", async () => {
    const harness = createHarness({ registerDefault: false });
    const lineage = {
      frameNonce: FRAME_NONCE,
      lineageToken: LINEAGE_TOKEN,
    };
    const client = blobWorkerClient("restarting-blob-worker");
    const expected = {
      adapterId: ADAPTER_ID,
      generation: GENERATION,
    } as TestAdapter;
    const registration = harness.registerBlobClient(expected, client, lineage);
    await vi.waitFor(() => expect(harness.owner.messages).toHaveLength(1));

    const recovered = harness.register(
      ADAPTER_ID,
      GENERATION,
      harness.owner,
      lineage,
    );
    await expect(registration).resolves.toMatchObject([
      { type: "cantrip-code-blob-client-registered-v2" },
    ]);

    const resource = harness.dispatch(testRequest(), { clientId: client.id });
    await vi.waitFor(() => expect(harness.requests(recovered)).toHaveLength(1));
    respond(harness, harness.requests(recovered)[0]!, recovered);
    await expect(resource).resolves.toMatchObject({ status: 200 });
  });

  it("restores a running blob worker on its first fetch after service-worker process restart", async () => {
    const harness = createHarness({ registerDefault: false });
    const lineage = {
      frameNonce: FRAME_NONCE,
      lineageToken: LINEAGE_TOKEN,
    };
    const client = blobWorkerClient("live-blob-after-worker-restart");
    harness.addClient(client);
    const registration = harness.dispatch(clientRegistrationRequest(lineage), {
      clientId: client.id,
    });
    await vi.waitFor(() => expect(harness.owner.messages).toHaveLength(1));

    const recovered = harness.register(
      ADAPTER_ID,
      GENERATION,
      harness.owner,
      lineage,
    );
    await expect(registration).resolves.toMatchObject({ status: 204 });

    const resource = harness.dispatch(testRequest(), { clientId: client.id });
    await vi.waitFor(() => expect(harness.requests(recovered)).toHaveLength(1));
    respond(harness, harness.requests(recovered)[0]!, recovered);
    await expect(resource).resolves.toMatchObject({ status: 200 });
  });

  it("rejects a blob registration fetch with the wrong private lineage", async () => {
    const harness = createHarness();
    const client = blobWorkerClient("wrong-lineage-registration-worker");
    harness.addClient(client);

    const response = await harness.dispatch(
      clientRegistrationRequest({
        frameNonce: FRAME_NONCE,
        lineageToken: OTHER_GENERATION,
      }),
      { clientId: client.id },
    );

    expect(response.status).toBe(403);
    expect(harness.requests()).toHaveLength(0);
  });

  it("deduplicates concurrent recovery notification and resumes every bound fetch", async () => {
    const harness = createHarness({ registerDefault: false });
    const firstClient = {
      ...topLevelClient(
        "existing-code-frame",
        `${ORIGIN}/__cantrip_code/${ADAPTER_ID}/code/`,
      ),
      frameType: "nested",
    } as const;
    const secondClient = {
      ...topLevelClient(
        "existing-extension-frame",
        `${ORIGIN}/__cantrip_code/${ADAPTER_ID}/code/webWorkerExtensionHostIframe.html`,
      ),
      frameType: "nested",
    } as const;
    harness.addClient(firstClient);
    harness.addClient(secondClient);
    const first = harness.dispatch(testRequest(), {
      clientId: firstClient.id,
    });
    const second = harness.dispatch(testRequest(), {
      clientId: secondClient.id,
    });
    await vi.waitFor(() => expect(harness.owner.messages).toHaveLength(1));

    expect(harness.clientMatchAll).toHaveBeenCalledOnce();
    const lineage = { frameNonce: FRAME_NONCE, lineageToken: LINEAGE_TOKEN };
    const recovered = harness.register(
      ADAPTER_ID,
      GENERATION,
      harness.owner,
      lineage,
    );
    await vi.waitFor(() => {
      expect(firstClient.messages).toHaveLength(1);
      expect(secondClient.messages).toHaveLength(1);
    });
    harness.respondClientChallenge(firstClient, recovered, lineage);
    harness.respondClientChallenge(secondClient, recovered, lineage);
    await vi.waitFor(() => expect(harness.requests(recovered)).toHaveLength(2));
    for (const request of harness.requests(recovered)) {
      respond(harness, request, recovered);
    }

    await expect(Promise.all([first, second])).resolves.toMatchObject([
      { status: 200 },
      { status: 200 },
    ]);
  });

  it("rejects a non-Code frame before broadcasting recovery", async () => {
    const harness = createHarness({ registerDefault: false });
    harness.addClient({
      ...topLevelClient("unrelated-frame", `${ORIGIN}/projects/project-two`),
      frameType: "nested",
    });
    const response = await harness.dispatch(testRequest(), {
      clientId: "unrelated-frame",
    });

    expect(response.status).toBe(403);
    expect(harness.owner.messages).toHaveLength(0);
  });

  it("times out when only the wrong adapter is registered", async () => {
    vi.useFakeTimers();
    const harness = createHarness({ registerDefault: false });
    harness.addClient({
      ...topLevelClient(
        "existing-code-frame",
        `${ORIGIN}/__cantrip_code/${ADAPTER_ID}/code/`,
      ),
      frameType: "nested",
    });
    const responsePromise = harness.dispatch(testRequest(), {
      clientId: "existing-code-frame",
    });
    await vi.advanceTimersByTimeAsync(0);

    const wrong = harness.register(OTHER_ADAPTER_ID, OTHER_GENERATION);
    expect(wrong.pagePort.received).toMatchObject([
      { type: "cantrip-code-adapter-registered-v2" },
    ]);
    await vi.advanceTimersByTimeAsync(ADAPTER_RECOVERY_TIMEOUT_MS);

    await expect(responsePromise).resolves.toMatchObject({ status: 503 });
    expect(harness.requests(wrong)).toHaveLength(0);
  });

  it("times out when an invalid owner attempts the exact recovery registration", async () => {
    vi.useFakeTimers();
    const harness = createHarness({ registerDefault: false });
    harness.addClient({
      ...topLevelClient(
        "existing-code-frame",
        `${ORIGIN}/__cantrip_code/${ADAPTER_ID}/code/`,
      ),
      frameType: "nested",
    });
    const responsePromise = harness.dispatch(testRequest(), {
      clientId: "existing-code-frame",
    });
    await vi.advanceTimersByTimeAsync(0);

    const invalidOwner = {
      ...topLevelClient("nested-owner"),
      frameType: "nested" as const,
    };
    const rejected = harness.register(
      ADAPTER_ID,
      OTHER_GENERATION,
      invalidOwner,
    );
    expect(rejected.pagePort.received).toMatchObject([
      { type: "cantrip-code-adapter-rejected-v2" },
    ]);
    await vi.advanceTimersByTimeAsync(ADAPTER_RECOVERY_TIMEOUT_MS);

    await expect(responsePromise).resolves.toMatchObject({ status: 503 });
  });

  it("rejects a duplicate generation without superseding the active port", async () => {
    const harness = createHarness();
    const active = requiredAdapter(harness);
    const duplicate = harness.register(ADAPTER_ID, OTHER_GENERATION);

    expect(duplicate.pagePort.received).toEqual([
      {
        adapterId: ADAPTER_ID,
        generation: OTHER_GENERATION,
        reason: "The adapter is already registered.",
        type: "cantrip-code-adapter-rejected-v2",
      },
    ]);
    expect(duplicate.workerPort.closed).toBe(true);

    const responsePromise = harness.dispatch(testRequest());
    await vi.waitFor(() => expect(harness.requests(active)).toHaveLength(1));
    respond(harness, harness.requests(active)[0]!, active);
    await expect(responsePromise).resolves.toMatchObject({ status: 200 });
  });

  it("rejects nested, adapter-frame, and cross-origin registration owners", () => {
    const harness = createHarness({ registerDefault: false });
    const invalidSources = [
      { ...topLevelClient("nested-owner"), frameType: "nested" as const },
      topLevelClient(
        "adapter-frame",
        `${ORIGIN}/__cantrip_code/${ADAPTER_ID}/code/`,
      ),
      topLevelClient("other-origin", "https://attacker.example/project"),
    ];

    for (const [index, source] of invalidSources.entries()) {
      const adapter = harness.register(
        [ADAPTER_ID, OTHER_ADAPTER_ID, THIRD_ADAPTER_ID][index]!,
        GENERATION,
        source,
      );
      expect(adapter.pagePort.received).toMatchObject([
        {
          reason: "The adapter owner was invalid.",
          type: "cantrip-code-adapter-rejected-v2",
        },
      ]);
      expect(adapter.workerPort.closed).toBe(true);
    }
  });

  it("requires the exact generation and owner to unregister", async () => {
    const harness = createHarness();
    const adapter = requiredAdapter(harness);
    const otherOwner = topLevelClient("other-owner");

    harness.unregister(adapter, OTHER_GENERATION);
    harness.unregisterFromClient(adapter, otherOwner);
    const activeResponse = harness.dispatch(testRequest());
    await vi.waitFor(() => expect(harness.requests()).toHaveLength(1));
    respond(harness, harness.requests()[0]!);
    await expect(activeResponse).resolves.toMatchObject({ status: 200 });

    harness.unregister(adapter);
    await expect(harness.dispatch(testRequest())).resolves.toMatchObject({
      status: 503,
    });
  });

  it("binds the first navigation to one resulting frame client", async () => {
    const harness = createHarness();
    const adapter = requiredAdapter(harness);
    const navigationResponse = harness.dispatch(navigationRequest(), {
      clientId: "",
      resultingClientId: "frame-one",
    });
    await vi.waitFor(() => expect(harness.requests()).toHaveLength(1));
    respond(harness, harness.requests()[0]!);
    await expect(navigationResponse).resolves.toMatchObject({ status: 200 });

    const wrongClient = await harness.dispatch(testRequest(), {
      clientId: "frame-two",
    });
    expect(wrongClient.status).toBe(403);
    expect(harness.requests()).toHaveLength(1);

    const frameResponse = harness.dispatch(testRequest(), {
      clientId: "frame-one",
    });
    await vi.waitFor(() => expect(harness.requests()).toHaveLength(2));
    respond(harness, harness.requests()[1]!, adapter);
    await expect(frameResponse).resolves.toMatchObject({ status: 200 });
  });

  it("does not let an empty-client navigation seize an adapter by UUID", async () => {
    const harness = createHarness();

    const response = await harness.dispatch(
      navigationRequest(
        "attacker_chosen_frame_nonce_1234",
        "attacker_chosen_root_lease_1234",
      ),
      { clientId: "", resultingClientId: "attacker-frame" },
    );

    expect(response.status).toBe(403);
    expect(harness.requests()).toHaveLength(0);
  });

  it("authorizes the real blob-worker bootstrap with exact frame lineage", async () => {
    const harness = createHarness();
    const adapter = requiredAdapter(harness);
    const navigation = harness.dispatch(navigationRequest(), {
      clientId: harness.owner.id,
      resultingClientId: "code-root",
    });
    await vi.waitFor(() => expect(harness.requests()).toHaveLength(1));
    respondHtml(harness, harness.requests()[0]!, adapter);
    const lineage = responseLineage(await (await navigation).text());
    expect(lineage).toMatchObject({
      frameNonce: FRAME_NONCE,
      generation: GENERATION,
    });
    harness.addClient({
      ...topLevelClient(
        "code-root",
        `${ORIGIN}/__cantrip_code/${ADAPTER_ID}/code/?cantripFrameNonce=${FRAME_NONCE}`,
      ),
      frameType: "nested",
    });

    const blobClient = blobWorkerClient("extension-host-blob-worker");
    await expect(
      harness.registerBlobClient(adapter, blobClient, lineage),
    ).resolves.toMatchObject([
      { type: "cantrip-code-blob-client-registered-v2" },
    ]);

    const workerResource = harness.dispatch(testRequest(), {
      clientId: blobClient.id,
    });
    await vi.waitFor(() => expect(harness.requests()).toHaveLength(2));
    respond(harness, harness.requests()[1]!, adapter);
    await expect(workerResource).resolves.toMatchObject({ status: 200 });

    await expect(
      harness.registerBlobClient(
        adapter,
        blobWorkerClient("unrelated-blob-worker"),
        { ...lineage, lineageToken: OTHER_GENERATION },
      ),
    ).resolves.toMatchObject([
      {
        reason: "The blob worker lineage was invalid.",
        type: "cantrip-code-adapter-rejected-v2",
      },
    ]);
  });

  it("rotates root lineage and revokes clients from the replaced workbench", async () => {
    const harness = createHarness();
    const adapter = requiredAdapter(harness);
    const firstNavigation = harness.dispatch(navigationRequest(), {
      clientId: harness.owner.id,
      resultingClientId: "root-one",
    });
    await vi.waitFor(() => expect(harness.requests()).toHaveLength(1));
    respondHtml(harness, harness.requests()[0]!, adapter);
    const firstLineage = responseLineage(await (await firstNavigation).text());
    harness.addClient({
      ...topLevelClient(
        "root-one",
        `${ORIGIN}/__cantrip_code/${ADAPTER_ID}/code/?cantripFrameNonce=${FRAME_NONCE}`,
      ),
      frameType: "nested",
    });
    const oldWorker = blobWorkerClient("old-root-worker");
    await harness.registerBlobClient(adapter, oldWorker, firstLineage);

    const replacementNonce = "service_worker_frame_nonce_replacement";
    harness.bindFrame(adapter, replacementNonce);
    const replacement = harness.dispatch(navigationRequest(replacementNonce), {
      clientId: harness.owner.id,
      resultingClientId: "root-two",
    });
    await vi.waitFor(() => expect(harness.requests()).toHaveLength(2));
    respondHtml(harness, harness.requests()[1]!, adapter);
    const replacementLineage = responseLineage(
      await (await replacement).text(),
    );
    expect(replacementLineage.lineageToken).not.toBe(firstLineage.lineageToken);

    await expect(
      harness.dispatch(testRequest(), { clientId: oldWorker.id }),
    ).resolves.toMatchObject({ status: 403 });
    await expect(
      harness.registerBlobClient(adapter, oldWorker, firstLineage),
    ).resolves.toMatchObject([
      {
        reason: "The blob worker lineage was invalid.",
        type: "cantrip-code-adapter-rejected-v2",
      },
    ]);
  });

  it("cancels stale HTML responses before a root rotation can expose its new lineage", async () => {
    const harness = createHarness();
    const adapter = requiredAdapter(harness);
    const firstNavigation = harness.dispatch(navigationRequest(), {
      clientId: harness.owner.id,
      resultingClientId: "delayed-response-root-one",
    });
    await vi.waitFor(() => expect(harness.requests()).toHaveLength(1));
    respondHtml(harness, harness.requests()[0]!, adapter);
    const firstLineage = responseLineage(await (await firstNavigation).text());
    const oldWorker = blobWorkerClient("delayed-response-old-worker");
    await harness.registerBlobClient(adapter, oldWorker, firstLineage);

    const staleResponsePromise = harness.dispatch(
      testRequest({ method: "GET" }),
      { clientId: oldWorker.id },
    );
    await vi.waitFor(() => expect(harness.requests()).toHaveLength(2));
    const staleRequest = harness.requests()[1]!;

    const replacementNonce = "delayed_response_replacement_nonce";
    const replacementPromise = harness.dispatch(
      navigationRequest(replacementNonce),
      {
        clientId: harness.owner.id,
        resultingClientId: "delayed-response-root-two",
      },
    );
    await vi.waitFor(() => expect(harness.requests()).toHaveLength(3));
    respondHtml(harness, harness.requests()[2]!, adapter);
    const replacementLineage = responseLineage(
      await (await replacementPromise).text(),
    );

    respondHtml(harness, staleRequest, adapter);
    const staleResponse = await staleResponsePromise;
    expect(staleResponse.status).toBe(503);
    expect(await staleResponse.text()).not.toContain(
      replacementLineage.lineageToken,
    );
    expect(harness.messages(adapter)).toContainEqual({
      adapterId: adapter.adapterId,
      requestId: staleRequest.requestId,
      type: "cantrip-code-http-cancel-v1",
    });
  });

  it("does not admit an old blob worker after root rotation wins an async prune race", async () => {
    const harness = createHarness();
    const adapter = requiredAdapter(harness);
    const firstNavigation = harness.dispatch(navigationRequest(), {
      clientId: harness.owner.id,
      resultingClientId: "raced-root-one",
    });
    await vi.waitFor(() => expect(harness.requests()).toHaveLength(1));
    respondHtml(harness, harness.requests()[0]!, adapter);
    const firstLineage = responseLineage(await (await firstNavigation).text());
    const oldRoot = {
      ...topLevelClient(
        "raced-root-one",
        `${ORIGIN}/__cantrip_code/${ADAPTER_ID}/code/?cantripFrameNonce=${FRAME_NONCE}`,
      ),
      frameType: "nested",
    } as const;
    harness.addClient(oldRoot);

    const prune = deferred<TestClient | undefined>();
    harness.clientGet.mockImplementationOnce(() => prune.promise);
    const oldWorker = blobWorkerClient("raced-old-blob-worker");
    const registration = harness.registerBlobClient(
      adapter,
      oldWorker,
      firstLineage,
    );
    await vi.waitFor(() => expect(harness.clientGet).toHaveBeenCalled());

    const replacementNonce = "service_worker_frame_nonce_race_replacement";
    harness.bindFrame(adapter, replacementNonce);
    const replacement = harness.dispatch(navigationRequest(replacementNonce), {
      clientId: harness.owner.id,
      resultingClientId: "raced-root-two",
    });
    await vi.waitFor(() => expect(harness.requests()).toHaveLength(2));
    respondHtml(harness, harness.requests()[1]!, adapter);
    await replacement;
    prune.resolve(oldRoot);

    await expect(registration).resolves.toMatchObject([
      {
        reason: "The blob worker lineage was superseded.",
        type: "cantrip-code-adapter-rejected-v2",
      },
    ]);
    await expect(
      harness.dispatch(testRequest(), { clientId: oldWorker.id }),
    ).resolves.toMatchObject({ status: 403 });
  });

  it("does not admit a stale nested navigation after root rotation wins an async prune race", async () => {
    const harness = createHarness();
    const adapter = requiredAdapter(harness);
    const firstNavigation = harness.dispatch(navigationRequest(), {
      clientId: harness.owner.id,
      resultingClientId: "nested-race-root-one",
    });
    await vi.waitFor(() => expect(harness.requests()).toHaveLength(1));
    respond(harness, harness.requests()[0]!, adapter);
    await firstNavigation;
    const oldRoot = {
      ...topLevelClient(
        "nested-race-root-one",
        `${ORIGIN}/__cantrip_code/${ADAPTER_ID}/code/?cantripFrameNonce=${FRAME_NONCE}`,
      ),
      frameType: "nested",
    } as const;
    harness.addClient(oldRoot);

    const prune = deferred<TestClient | undefined>();
    harness.clientGet.mockImplementationOnce(() => prune.promise);
    const staleNavigation = harness.dispatch(
      testRequest({
        method: "GET",
        mode: "navigate",
        url: `${ORIGIN}/__cantrip_code/${ADAPTER_ID}/code/stale-frame.html`,
      }),
      {
        clientId: oldRoot.id,
        resultingClientId: "stale-nested-frame",
      },
    );
    await vi.waitFor(() => expect(harness.clientGet).toHaveBeenCalled());

    const replacementNonce = "service_worker_frame_nonce_nested_race";
    harness.bindFrame(adapter, replacementNonce);
    const replacement = harness.dispatch(navigationRequest(replacementNonce), {
      clientId: harness.owner.id,
      resultingClientId: "nested-race-root-two",
    });
    await vi.waitFor(() => expect(harness.requests()).toHaveLength(2));
    respond(harness, harness.requests()[1]!, adapter);
    await replacement;
    prune.resolve(oldRoot);

    await expect(staleNavigation).resolves.toMatchObject({ status: 403 });
    await expect(
      harness.dispatch(testRequest(), { clientId: "stale-nested-frame" }),
    ).resolves.toMatchObject({ status: 403 });
  });

  it("prunes terminated descendants before enforcing the client bound", async () => {
    const harness = createHarness();
    const adapter = requiredAdapter(harness);
    const navigation = harness.dispatch(navigationRequest(), {
      clientId: harness.owner.id,
      resultingClientId: "bounded-root",
    });
    await vi.waitFor(() => expect(harness.requests()).toHaveLength(1));
    respondHtml(harness, harness.requests()[0]!, adapter);
    const lineage = responseLineage(await (await navigation).text());
    harness.addClient({
      ...topLevelClient(
        "bounded-root",
        `${ORIGIN}/__cantrip_code/${ADAPTER_ID}/code/?cantripFrameNonce=${FRAME_NONCE}`,
      ),
      frameType: "nested",
    });

    const clients = Array.from({ length: 63 }, (_, index) =>
      blobWorkerClient(`bounded-worker-${index}`),
    );
    for (const client of clients) {
      await expect(
        harness.registerBlobClient(adapter, client, lineage),
      ).resolves.toMatchObject([
        { type: "cantrip-code-blob-client-registered-v2" },
      ]);
    }
    await expect(
      harness.registerBlobClient(
        adapter,
        blobWorkerClient("bounded-worker-overflow"),
        lineage,
      ),
    ).resolves.toMatchObject([
      {
        reason: "The protected Code client limit was reached.",
        type: "cantrip-code-adapter-rejected-v2",
      },
    ]);

    harness.removeClient(clients[0]!.id);
    await expect(
      harness.registerBlobClient(
        adapter,
        blobWorkerClient("bounded-worker-after-prune"),
        lineage,
      ),
    ).resolves.toMatchObject([
      { type: "cantrip-code-blob-client-registered-v2" },
    ]);
  });

  it("authorizes bounded descendant frame clients without admitting siblings", async () => {
    const harness = createHarness();
    const adapter = requiredAdapter(harness);
    const outerNavigation = harness.dispatch(navigationRequest(), {
      clientId: harness.owner.id,
      resultingClientId: "outer-frame",
    });
    await vi.waitFor(() => expect(harness.requests()).toHaveLength(1));
    respond(harness, harness.requests()[0]!, adapter);
    await outerNavigation;
    harness.addClient({
      ...topLevelClient(
        "outer-frame",
        `${ORIGIN}/__cantrip_code/${ADAPTER_ID}/code/?cantripFrameNonce=${FRAME_NONCE}`,
      ),
      frameType: "nested",
    });

    const nestedNavigation = harness.dispatch(
      testRequest({
        method: "GET",
        mode: "navigate",
        url: `${ORIGIN}/__cantrip_code/${ADAPTER_ID}/code/webWorkerExtensionHostIframe.html`,
      }),
      {
        clientId: "outer-frame",
        resultingClientId: "extension-frame",
      },
    );
    await vi.waitFor(() => expect(harness.requests()).toHaveLength(2));
    respond(harness, harness.requests()[1]!, adapter);
    await nestedNavigation;
    harness.addClient({
      ...topLevelClient(
        "extension-frame",
        `${ORIGIN}/__cantrip_code/${ADAPTER_ID}/code/webWorkerExtensionHostIframe.html`,
      ),
      frameType: "nested",
    });

    const nestedResource = harness.dispatch(testRequest(), {
      clientId: "extension-frame",
    });
    await vi.waitFor(() => expect(harness.requests()).toHaveLength(3));
    respond(harness, harness.requests()[2]!, adapter);
    await expect(nestedResource).resolves.toMatchObject({ status: 200 });

    const workerBootstrap = harness.dispatch(testRequest(), {
      clientId: "extension-frame",
      resultingClientId: "extension-worker",
    });
    await vi.waitFor(() => expect(harness.requests()).toHaveLength(4));
    respond(harness, harness.requests()[3]!, adapter);
    await workerBootstrap;

    const workerResource = harness.dispatch(testRequest(), {
      clientId: "extension-worker",
    });
    await vi.waitFor(() => expect(harness.requests()).toHaveLength(5));
    respond(harness, harness.requests()[4]!, adapter);
    await expect(workerResource).resolves.toMatchObject({ status: 200 });

    await expect(
      harness.dispatch(testRequest(), { clientId: "sibling-frame" }),
    ).resolves.toMatchObject({ status: 403 });
    expect(harness.requests()).toHaveLength(5);
  });

  it("rebinds a frame reload and retires the old client", async () => {
    const harness = createHarness();
    const adapter = requiredAdapter(harness);
    harness.bindFrame(adapter, "service_worker_frame_nonce_5678");
    const firstNavigation = harness.dispatch(
      navigationRequest("service_worker_frame_nonce_5678"),
      { clientId: harness.owner.id, resultingClientId: "frame-one" },
    );
    await vi.waitFor(() => expect(harness.requests()).toHaveLength(1));
    respond(harness, harness.requests()[0]!);
    await firstNavigation;

    harness.bindFrame(adapter, "service_worker_frame_nonce_9012");
    const reload = harness.dispatch(
      navigationRequest("service_worker_frame_nonce_9012"),
      {
        clientId: "frame-one",
        replacesClientId: "frame-one",
        resultingClientId: "frame-two",
      },
    );
    await vi.waitFor(() => expect(harness.requests()).toHaveLength(2));
    respond(harness, harness.requests()[1]!);
    await reload;

    await expect(
      harness.dispatch(testRequest(), { clientId: "frame-one" }),
    ).resolves.toMatchObject({ status: 403 });
    const currentFrame = harness.dispatch(testRequest(), {
      clientId: "frame-two",
    });
    await vi.waitFor(() => expect(harness.requests()).toHaveLength(3));
    respond(harness, harness.requests()[2]!);
    await expect(currentFrame).resolves.toMatchObject({ status: 200 });
  });

  it("preserves public requests and ignores wrong-adapter responses on the exact port", async () => {
    const harness = createHarness();
    const responsePromise = harness.dispatch(testRequest());
    await vi.waitFor(() => expect(harness.requests()).toHaveLength(1));
    const request = harness.requests()[0]!;
    expect(request.url).toBe(`${ORIGIN}/__cantrip_code/${ADAPTER_ID}/code/`);
    expect(request).not.toHaveProperty("routeGrant");
    let settled = false;
    void responsePromise.then(() => {
      settled = true;
    });

    respond(harness, request, requiredAdapter(harness), OTHER_ADAPTER_ID);
    await Promise.resolve();
    expect(settled).toBe(false);
    respond(harness, request);

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
      testRequest({ body, method: "POST" }),
    );

    expect(response.status).toBe(413);
    expect(pulls).toBe(17);
    expect(cancel).toHaveBeenCalledOnce();
    expect(harness.requests()).toHaveLength(0);
    expect(await response.text()).toMatch(/too large/iu);
  });

  it("enforces one absolute deadline across streaming ingress and port delivery", async () => {
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
      testRequest({ body, method: "POST" }),
    );

    await vi.advanceTimersByTimeAsync(20_000);
    expect(harness.requests()).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(10_000);

    expect((await responsePromise).status).toBe(504);
    expect(
      harness
        .messages()
        .filter(({ type }) => type === "cantrip-code-http-cancel-v1"),
    ).toHaveLength(1);
  });

  it("bounds concurrent ingress per adapter and releases a slot", async () => {
    const harness = createHarness();
    const pending = Array.from(
      { length: MAX_CONCURRENT_ADAPTER_REQUESTS },
      () => harness.dispatch(testRequest()),
    );
    const overflowCancel = vi.fn();
    const overflow = harness.dispatch(
      testRequest({
        body: new ReadableStream<Uint8Array>({ cancel: overflowCancel }),
        method: "POST",
      }),
    );
    await vi.waitFor(() =>
      expect(harness.requests()).toHaveLength(MAX_CONCURRENT_ADAPTER_REQUESTS),
    );

    await expect(overflow).resolves.toMatchObject({ status: 429 });
    expect(overflowCancel).toHaveBeenCalledOnce();
    for (const request of harness.requests()) respond(harness, request);
    await Promise.all(pending);

    const afterSettlement = harness.dispatch(testRequest());
    await vi.waitFor(() =>
      expect(harness.requests()).toHaveLength(
        MAX_CONCURRENT_ADAPTER_REQUESTS + 1,
      ),
    );
    respond(harness, harness.requests().at(-1)!);
    await expect(afterSettlement).resolves.toMatchObject({ status: 200 });
  });

  it("bounds global ingress without allowing one adapter to consume every slot", async () => {
    const harness = createHarness();
    const first = requiredAdapter(harness);
    const second = harness.register(OTHER_ADAPTER_ID);
    const third = harness.register(THIRD_ADAPTER_ID);
    const firstPending = Array.from({ length: 16 }, () =>
      harness.dispatch(testRequest()),
    );
    const secondPending = Array.from({ length: 16 }, () =>
      harness.dispatch(testRequest({ method: "GET" }, OTHER_ADAPTER_ID)),
    );

    await vi.waitFor(() => {
      expect(harness.requests(first)).toHaveLength(16);
      expect(harness.requests(second)).toHaveLength(16);
    });
    await expect(
      harness.dispatch(testRequest({ method: "GET" }, THIRD_ADAPTER_ID)),
    ).resolves.toMatchObject({ status: 429 });
    expect(harness.requests(third)).toHaveLength(0);

    for (const request of harness.requests(first))
      respond(harness, request, first);
    for (const request of harness.requests(second))
      respond(harness, request, second);
    await Promise.all([...firstPending, ...secondPending]);
    expect(MAX_CONCURRENT_REQUESTS).toBe(32);
  });

  it("propagates request cancellation to the exact adapter port once", async () => {
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
      harness
        .messages()
        .filter(({ type }) => type === "cantrip-code-http-cancel-v1"),
    ).toHaveLength(1);
  });

  it("fails pending requests and cancels page work on exact unregister", async () => {
    const harness = createHarness();
    const adapter = requiredAdapter(harness);
    const responsePromise = harness.dispatch(testRequest());
    await vi.waitFor(() => expect(harness.requests()).toHaveLength(1));

    harness.unregister(adapter);

    await expect(responsePromise).resolves.toMatchObject({ status: 503 });
    expect(
      harness
        .messages()
        .filter(({ type }) => type === "cantrip-code-http-cancel-v1"),
    ).toHaveLength(1);
    expect(adapter.workerPort.closed).toBe(true);
  });

  it("preserves an exact port-side failure as an HTTP 502 response", async () => {
    const response = await respondWith({ error: "upstream failure" });

    expect(response.status).toBe(502);
    expect(await response.text()).toBe("upstream failure");
  });

  it.each([
    {
      name: "missing status",
      response: { body: new ArrayBuffer(0), headers: [], statusText: "OK" },
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
    "rejects malformed port response metadata: $name",
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

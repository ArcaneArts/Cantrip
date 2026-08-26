const adapters = new Map();
const pending = new Map();
const pendingClientAuthorizations = new Map();
const registrationWaiters = new Map();
const CODE_PATH =
  /^\/__cantrip_code\/([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\/code(?:\/|$)/iu;
const CLIENT_REGISTRATION_PATH =
  /^\/__cantrip_code\/([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\/code\/__cantrip_client_register_v2$/iu;
const IDENTITY =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const FRAME_NONCE = /^[A-Za-z0-9_-]{16,128}$/u;
const MAX_REQUEST_BYTES = 16 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 64 * 1024 * 1024;
const MAX_HEADER_BYTES = 64 * 1024;
const MAX_HEADER_COUNT = 256;
const MAX_CONCURRENT_REQUESTS = 32;
const MAX_CONCURRENT_ADAPTER_REQUESTS = 24;
const MAX_ADAPTER_CLIENTS = 64;
const MAX_PENDING_ADAPTER_RECOVERIES = 32;
const ADAPTER_RECOVERY_TIMEOUT_MS = 1_500;
const CLIENT_AUTHORIZATION_TIMEOUT_MS = 1_500;
const REQUEST_DEADLINE_MS = 30_000;
const textEncoder = new TextEncoder();
let activeRequestCount = 0;

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) =>
  event.waitUntil(self.clients.claim()),
);

function eligibleTopLevelClient(source) {
  if (
    !source ||
    source.type !== "window" ||
    source.frameType !== "top-level" ||
    typeof source.id !== "string" ||
    !source.id
  ) {
    return null;
  }
  try {
    const url = new URL(source.url);
    return url.origin === self.location.origin && !CODE_PATH.test(url.pathname)
      ? source
      : null;
  } catch {
    return null;
  }
}

function registrationSource(event) {
  return eligibleTopLevelClient(event.source);
}

function protectedCodeClient(client, adapterId) {
  if (
    !client ||
    !["window", "worker", "sharedworker"].includes(client.type) ||
    typeof client.url !== "string"
  ) {
    return false;
  }
  try {
    const clientUrl = new URL(client.url);
    const match = CODE_PATH.exec(clientUrl.pathname);
    return (
      clientUrl.origin === self.location.origin && match?.[1] === adapterId
    );
  } catch {
    return false;
  }
}

function protectedBlobClient(client) {
  if (
    !client ||
    !["worker", "sharedworker"].includes(client.type) ||
    typeof client.id !== "string" ||
    !client.id ||
    typeof client.url !== "string"
  ) {
    return false;
  }
  try {
    const clientUrl = new URL(client.url);
    return (
      clientUrl.protocol === "blob:" &&
      clientUrl.origin === self.location.origin
    );
  } catch {
    return false;
  }
}

function adapterLineage(message) {
  return message &&
    typeof message.frameNonce === "string" &&
    FRAME_NONCE.test(message.frameNonce) &&
    typeof message.lineageToken === "string" &&
    IDENTITY.test(message.lineageToken)
    ? {
        frameNonce: message.frameNonce,
        lineageToken: message.lineageToken,
      }
    : null;
}

function adapterIdentity(message) {
  return message &&
    typeof message.adapterId === "string" &&
    message.adapterId === message.adapterId.toLowerCase() &&
    IDENTITY.test(message.adapterId) &&
    typeof message.generation === "string" &&
    IDENTITY.test(message.generation)
    ? { adapterId: message.adapterId, generation: message.generation }
    : null;
}

function adapterRootLease(message) {
  return message &&
    typeof message.rootLease === "string" &&
    FRAME_NONCE.test(message.rootLease)
    ? message.rootLease
    : null;
}

async function adapterFingerprint(adapterId) {
  const digest = new Uint8Array(
    await crypto.subtle.digest(
      "SHA-256",
      textEncoder.encode(adapterId.toLowerCase()),
    ),
  );
  let binary = "";
  for (const byte of digest) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replace(/\+/gu, "-")
    .replace(/\//gu, "_")
    .replace(/=+$/gu, "");
}

async function notifyAdapterRegistrationRequired(adapterId) {
  let fingerprint;
  try {
    fingerprint = await adapterFingerprint(adapterId);
  } catch {
    return;
  }
  let clients;
  try {
    clients = await self.clients.matchAll({
      includeUncontrolled: true,
      type: "window",
    });
  } catch {
    return;
  }
  for (const client of clients) {
    if (!eligibleTopLevelClient(client)) continue;
    try {
      client.postMessage({
        adapterFingerprint: fingerprint,
        type: "cantrip-code-adapter-registration-required-v2",
      });
    } catch {
      // Another eligible owner may still recover the exact live adapter.
    }
  }
}

function waitForAdapterRegistration(adapterId) {
  const existing = registrationWaiters.get(adapterId);
  if (existing) return existing.promise;
  if (registrationWaiters.size >= MAX_PENDING_ADAPTER_RECOVERIES) {
    return Promise.resolve(null);
  }
  let resolve;
  const promise = new Promise((nextResolve) => {
    resolve = nextResolve;
  });
  const waiter = {
    promise,
    resolve,
    timer: setTimeout(() => {
      if (registrationWaiters.get(adapterId) !== waiter) return;
      registrationWaiters.delete(adapterId);
      resolve(null);
    }, ADAPTER_RECOVERY_TIMEOUT_MS),
  };
  registrationWaiters.set(adapterId, waiter);
  void notifyAdapterRegistrationRequired(adapterId);
  return promise;
}

function completeAdapterRegistration(adapter) {
  const waiter = registrationWaiters.get(adapter.adapterId);
  if (!waiter) return;
  registrationWaiters.delete(adapter.adapterId);
  clearTimeout(waiter.timer);
  waiter.resolve(adapter);
}

function rejectRegistration(port, identity, reason) {
  try {
    port.postMessage({
      ...identity,
      reason,
      type: "cantrip-code-adapter-rejected-v2",
    });
  } catch {
    // Rejection is best-effort; the caller still cannot acquire authority.
  } finally {
    try {
      port.close();
    } catch {
      // The rejected port never entered the adapter registry.
    }
  }
}

function resolveClientAuthorization(authorization, authorized) {
  if (pendingClientAuthorizations.get(authorization.key) === authorization) {
    pendingClientAuthorizations.delete(authorization.key);
  }
  clearTimeout(authorization.timer);
  authorization.resolve(authorized);
}

function revokePendingClientAuthorizations(adapter) {
  for (const authorization of pendingClientAuthorizations.values()) {
    if (authorization.adapter !== adapter) continue;
    resolveClientAuthorization(authorization, false);
  }
}

function supersedeAdapterEpoch(adapter, reason) {
  adapter.epoch += 1;
  const failure = new ProxyRequestError(reason, 503);
  for (const context of [...adapter.contexts]) context.fail(failure);
  revokePendingClientAuthorizations(adapter);
}

function retireAdapter(adapter, reason) {
  if (adapter.retired) return;
  adapter.retired = true;
  adapter.epoch += 1;
  if (adapters.get(adapter.adapterId) === adapter) {
    adapters.delete(adapter.adapterId);
  }
  adapter.port.removeEventListener("message", adapter.onMessage);
  adapter.port.removeEventListener("messageerror", adapter.onMessageError);
  const failure = new ProxyRequestError(reason, 503);
  for (const context of [...adapter.contexts]) context.fail(failure);
  revokePendingClientAuthorizations(adapter);
  try {
    adapter.port.close();
  } catch {
    // The exact adapter generation is already retired locally.
  }
}

function receiveAdapterMessage(adapter, message) {
  if (
    adapter.retired ||
    adapters.get(adapter.adapterId) !== adapter ||
    !message ||
    message.adapterId !== adapter.adapterId
  ) {
    return;
  }
  if (
    message.type === "cantrip-code-adapter-unregister-v2" &&
    message.generation === adapter.generation
  ) {
    retireAdapter(adapter, "The protected Code adapter was unregistered.");
    return;
  }
  if (
    message.type === "cantrip-code-adapter-frame-bound-v2" &&
    message.generation === adapter.generation &&
    typeof message.frameNonce === "string" &&
    FRAME_NONCE.test(message.frameNonce)
  ) {
    if (adapter.expectedFrameNonce !== message.frameNonce) {
      supersedeAdapterEpoch(
        adapter,
        "The protected Code workbench frame was superseded.",
      );
      adapter.expectedFrameNonce = message.frameNonce;
    }
    return;
  }
  if (
    message.type === "cantrip-code-adapter-lineage-v2" &&
    message.generation === adapter.generation
  ) {
    const lineage = adapterLineage(message);
    if (
      lineage &&
      adapter.frameNonce === lineage.frameNonce &&
      (adapter.lineageToken === null ||
        adapter.lineageToken === lineage.lineageToken)
    ) {
      adapter.lineageToken = lineage.lineageToken;
    }
    return;
  }
  if (message.type !== "cantrip-code-http-response-v1") return;
  const request = pending.get(message.requestId);
  if (!request || request.adapter !== adapter) return;
  request.receive(message);
}

self.addEventListener("message", (event) => {
  const message = event.data;
  if (message?.type === "cantrip-code-adapter-protocol-probe-v2") {
    const port = event.ports?.length === 1 ? event.ports[0] : null;
    if (!port || !registrationSource(event)) {
      try {
        port?.close();
      } catch {
        // An invalid probe never acquires adapter authority.
      }
      return;
    }
    try {
      port.postMessage({
        type: "cantrip-code-adapter-protocol-ready-v2",
        version: 2,
      });
    } finally {
      try {
        port.close();
      } catch {
        // The one-shot compatibility channel is already complete.
      }
    }
    return;
  }
  const identity = adapterIdentity(message);
  if (!identity) return;
  if (message.type === "cantrip-code-client-lineage-response-v2") {
    const source = event.source;
    const sourceId = typeof source?.id === "string" ? source.id : "";
    const authorization = pendingClientAuthorizations.get(
      `${identity.adapterId}:${sourceId}`,
    );
    const lineage = adapterLineage(message);
    if (
      !authorization ||
      authorization.challenge !== message.challenge ||
      authorization.adapter.generation !== identity.generation ||
      authorization.epoch !== authorization.adapter.epoch ||
      adapters.get(identity.adapterId) !== authorization.adapter ||
      authorization.adapter.retired ||
      !lineage ||
      authorization.adapter.frameNonce !== lineage.frameNonce ||
      authorization.adapter.lineageToken !== lineage.lineageToken
    ) {
      return;
    }
    pendingClientAuthorizations.delete(authorization.key);
    clearTimeout(authorization.timer);
    const admission = addAdapterClient(
      authorization.adapter,
      sourceId,
      authorization.epoch,
    ).then(authorization.resolve, () => authorization.resolve(false));
    event.waitUntil?.(admission);
    return;
  }
  if (message.type === "cantrip-code-blob-client-register-v2") {
    const port = event.ports?.length === 1 ? event.ports[0] : null;
    const lineage = adapterLineage(message);
    const source = event.source;
    const registration = (async () => {
      let adapter = adapters.get(identity.adapterId);
      if (!adapter && port && lineage && protectedBlobClient(source)) {
        adapter = await waitForAdapterRegistration(identity.adapterId);
      }
      if (
        !port ||
        !adapter ||
        adapter.retired ||
        adapter.generation !== identity.generation ||
        !lineage ||
        adapter.frameNonce !== lineage.frameNonce ||
        adapter.lineageToken !== lineage.lineageToken ||
        !protectedBlobClient(source)
      ) {
        rejectRegistration(
          port,
          identity,
          "The blob worker lineage was invalid.",
        );
        return;
      }
      const epoch = adapter.epoch;
      if (!(await pruneAdapterClients(adapter, epoch))) {
        rejectRegistration(
          port,
          identity,
          "The blob worker lineage was superseded.",
        );
        return;
      }
      if (
        adapter.retired ||
        adapters.get(identity.adapterId) !== adapter ||
        adapter.epoch !== epoch ||
        adapter.generation !== identity.generation ||
        adapter.frameNonce !== lineage.frameNonce ||
        adapter.lineageToken !== lineage.lineageToken
      ) {
        rejectRegistration(
          port,
          identity,
          "The blob worker lineage was superseded.",
        );
        return;
      }
      if (
        !adapter.adapterClientIds.has(source.id) &&
        adapter.adapterClientIds.size >= MAX_ADAPTER_CLIENTS
      ) {
        rejectRegistration(
          port,
          identity,
          "The protected Code client limit was reached.",
        );
        return;
      }
      adapter.adapterClientIds.add(source.id);
      try {
        port.postMessage({
          ...identity,
          type: "cantrip-code-blob-client-registered-v2",
        });
      } finally {
        try {
          port.close();
        } catch {
          // The one-shot worker authorization channel is already complete.
        }
      }
    })();
    event.waitUntil?.(registration);
    return;
  }
  const source = registrationSource(event);
  if (message.type === "cantrip-code-adapter-register-v2") {
    const port = event.ports?.length === 1 ? event.ports[0] : null;
    if (
      !port ||
      typeof port.addEventListener !== "function" ||
      typeof port.removeEventListener !== "function" ||
      typeof port.postMessage !== "function" ||
      typeof port.start !== "function" ||
      typeof port.close !== "function"
    ) {
      return;
    }
    if (!source) {
      rejectRegistration(port, identity, "The adapter owner was invalid.");
      return;
    }
    if (adapters.has(identity.adapterId)) {
      rejectRegistration(port, identity, "The adapter is already registered.");
      return;
    }
    const rootLease = adapterRootLease(message);
    if (!rootLease) {
      rejectRegistration(port, identity, "The adapter root lease was invalid.");
      return;
    }
    const suppliedLineage = adapterLineage(message);
    const suppliedLineageFields =
      message.frameNonce === undefined && message.lineageToken === undefined;
    if (!suppliedLineageFields && !suppliedLineage) {
      rejectRegistration(port, identity, "The adapter lineage was invalid.");
      return;
    }
    const adapter = {
      ...identity,
      activeRequestCount: 0,
      contexts: new Set(),
      epoch: 0,
      expectedFrameNonce: suppliedLineage?.frameNonce ?? null,
      adapterClientIds: new Set(),
      frameNonce: suppliedLineage?.frameNonce ?? null,
      lineageToken: suppliedLineage?.lineageToken ?? null,
      ownerClientId: source.id,
      port,
      retired: false,
      rootClientId: null,
      rootLease,
      onMessage: null,
      onMessageError: null,
    };
    adapter.onMessage = (messageEvent) =>
      receiveAdapterMessage(adapter, messageEvent.data);
    adapter.onMessageError = () =>
      retireAdapter(adapter, "The protected Code adapter channel failed.");
    try {
      port.addEventListener("message", adapter.onMessage);
      port.addEventListener("messageerror", adapter.onMessageError);
      port.start();
      adapters.set(adapter.adapterId, adapter);
      port.postMessage({
        ...identity,
        type: "cantrip-code-adapter-registered-v2",
      });
      completeAdapterRegistration(adapter);
    } catch {
      retireAdapter(adapter, "The protected Code adapter channel failed.");
    }
    return;
  }
  if (message.type !== "cantrip-code-adapter-unregister-v2" || !source) {
    return;
  }
  const adapter = adapters.get(identity.adapterId);
  if (
    !adapter ||
    adapter.generation !== identity.generation ||
    adapter.ownerClientId !== source.id
  ) {
    return;
  }
  retireAdapter(adapter, "The protected Code adapter was unregistered.");
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  const clientRegistration = CLIENT_REGISTRATION_PATH.exec(url.pathname);
  if (clientRegistration) {
    event.respondWith(
      registerBlobClientRequest(event, clientRegistration[1].toLowerCase()),
    );
    return;
  }
  const match = CODE_PATH.exec(url.pathname);
  if (!match) return;
  event.respondWith(proxyRequest(event, match[1].toLowerCase()));
});

async function registerBlobClientRequest(event, adapterId) {
  if (event.request.method !== "POST") {
    return new Response(null, {
      headers: { "cache-control": "no-store" },
      status: 405,
    });
  }
  const clientId = typeof event.clientId === "string" ? event.clientId : "";
  let source;
  try {
    source = clientId ? await self.clients.get(clientId) : null;
  } catch {
    source = null;
  }
  const identity = adapterIdentity({
    adapterId,
    generation: event.request.headers.get("x-cantrip-code-generation"),
  });
  const lineage = adapterLineage({
    frameNonce: event.request.headers.get("x-cantrip-code-frame-nonce"),
    lineageToken: event.request.headers.get("x-cantrip-code-lineage-token"),
  });
  if (!identity || !lineage || !protectedBlobClient(source)) {
    return new Response(null, {
      headers: { "cache-control": "no-store" },
      status: 403,
    });
  }
  let adapter = adapters.get(adapterId);
  if (!adapter) adapter = await waitForAdapterRegistration(adapterId);
  if (
    !adapter ||
    adapter.retired ||
    adapters.get(adapterId) !== adapter ||
    adapter.generation !== identity.generation ||
    adapter.frameNonce !== lineage.frameNonce ||
    adapter.lineageToken !== lineage.lineageToken
  ) {
    return new Response(null, {
      headers: { "cache-control": "no-store" },
      status: adapter ? 403 : 503,
    });
  }
  const epoch = adapter.epoch;
  const admitted = await addAdapterClient(adapter, clientId, epoch);
  if (
    !admitted ||
    !adapterEpochIsCurrent(adapter, epoch) ||
    adapter.frameNonce !== lineage.frameNonce ||
    adapter.lineageToken !== lineage.lineageToken
  ) {
    return new Response(null, {
      headers: { "cache-control": "no-store" },
      status: 403,
    });
  }
  return new Response(null, {
    headers: { "cache-control": "no-store" },
    status: 204,
  });
}

function adapterEpochIsCurrent(adapter, epoch) {
  return (
    !adapter.retired &&
    adapters.get(adapter.adapterId) === adapter &&
    adapter.epoch === epoch
  );
}

async function pruneAdapterClients(adapter, epoch = adapter.epoch) {
  const clients = await Promise.all(
    [...adapter.adapterClientIds].map(async (clientId) => {
      try {
        return [clientId, await self.clients.get(clientId)];
      } catch {
        return [clientId, null];
      }
    }),
  );
  if (!adapterEpochIsCurrent(adapter, epoch)) return false;
  for (const [clientId, client] of clients) {
    if (
      client &&
      (protectedBlobClient(client) ||
        protectedCodeClient(client, adapter.adapterId))
    ) {
      continue;
    }
    adapter.adapterClientIds.delete(clientId);
    if (adapter.rootClientId === clientId) adapter.rootClientId = null;
  }
  return adapterEpochIsCurrent(adapter, epoch);
}

function requestFrameNonce(request) {
  try {
    const value = new URL(request.url).searchParams.get("cantripFrameNonce");
    return value && FRAME_NONCE.test(value) ? value : null;
  } catch {
    return null;
  }
}

function requestRootLease(request) {
  try {
    const value = new URL(request.url).searchParams.get("cantripRootLease");
    return value && FRAME_NONCE.test(value) ? value : null;
  } catch {
    return null;
  }
}

async function addAdapterClient(adapter, clientId, epoch = adapter.epoch) {
  if (!adapterEpochIsCurrent(adapter, epoch)) return false;
  if (!clientId || adapter.adapterClientIds.has(clientId)) return true;
  if (!(await pruneAdapterClients(adapter, epoch))) return false;
  if (!adapterEpochIsCurrent(adapter, epoch)) return false;
  if (adapter.adapterClientIds.size >= MAX_ADAPTER_CLIENTS) return false;
  adapter.adapterClientIds.add(clientId);
  return true;
}

function rotateAdapterRoot(adapter, frameNonce, rootClientId) {
  supersedeAdapterEpoch(
    adapter,
    "The protected Code workbench frame was superseded.",
  );
  adapter.adapterClientIds.clear();
  adapter.expectedFrameNonce = frameNonce;
  adapter.frameNonce = frameNonce;
  adapter.lineageToken = crypto.randomUUID();
  adapter.rootClientId = rootClientId;
  adapter.adapterClientIds.add(rootClientId);
}

function authorizeAdapterFetch(event, adapter) {
  const clientId = typeof event.clientId === "string" ? event.clientId : "";
  const resultingClientId =
    typeof event.resultingClientId === "string" ? event.resultingClientId : "";
  const replacesClientId =
    typeof event.replacesClientId === "string" ? event.replacesClientId : "";
  const navigation = event.request.mode === "navigate";
  if (
    navigation &&
    resultingClientId &&
    (clientId === "" || clientId === adapter.ownerClientId)
  ) {
    const frameNonce = requestFrameNonce(event.request);
    if (!frameNonce || requestRootLease(event.request) !== adapter.rootLease) {
      return false;
    }
    rotateAdapterRoot(adapter, frameNonce, resultingClientId);
    return true;
  }
  if (clientId === adapter.ownerClientId) return true;
  const currentFrame =
    adapter.adapterClientIds.has(clientId) ||
    adapter.adapterClientIds.has(replacesClientId);
  if (!currentFrame) return false;
  if (
    navigation &&
    adapter.rootClientId &&
    replacesClientId === adapter.rootClientId &&
    resultingClientId
  ) {
    const frameNonce = requestFrameNonce(event.request);
    if (!frameNonce || requestRootLease(event.request) !== adapter.rootLease) {
      return false;
    }
    rotateAdapterRoot(adapter, frameNonce, resultingClientId);
    return true;
  }
  if (resultingClientId) {
    const epoch = adapter.epoch;
    return addAdapterClient(adapter, resultingClientId, epoch).then((added) => {
      if (!added) return false;
      if (!adapterEpochIsCurrent(adapter, epoch)) return false;
      if (replacesClientId && replacesClientId !== resultingClientId) {
        adapter.adapterClientIds.delete(replacesClientId);
        if (adapter.rootClientId === replacesClientId) {
          adapter.rootClientId = resultingClientId;
        }
      }
      return true;
    });
  }
  if (replacesClientId && replacesClientId !== clientId) {
    adapter.adapterClientIds.delete(replacesClientId);
    if (adapter.rootClientId === replacesClientId) {
      adapter.rootClientId = clientId || null;
    }
  }
  return true;
}

async function authorizeAdapterClientByChallenge(adapter, clientId) {
  if (!clientId) return false;
  if (adapter.adapterClientIds.has(clientId)) return true;
  const key = `${adapter.adapterId}:${clientId}`;
  const existing = pendingClientAuthorizations.get(key);
  if (
    existing &&
    existing.adapter === adapter &&
    existing.epoch === adapter.epoch
  ) {
    return existing.promise;
  }
  if (existing) resolveClientAuthorization(existing, false);
  let client;
  try {
    client = await self.clients.get(clientId);
  } catch {
    return false;
  }
  const epoch = adapter.epoch;
  if (
    !adapterEpochIsCurrent(adapter, epoch) ||
    !adapter.frameNonce ||
    !adapter.lineageToken ||
    (!protectedCodeClient(client, adapter.adapterId) &&
      !protectedBlobClient(client))
  ) {
    return false;
  }
  const competing = pendingClientAuthorizations.get(key);
  if (competing && competing.adapter === adapter && competing.epoch === epoch) {
    return competing.promise;
  }
  if (competing) resolveClientAuthorization(competing, false);
  let resolve;
  const promise = new Promise((nextResolve) => {
    resolve = nextResolve;
  });
  const authorization = {
    adapter,
    challenge: crypto.randomUUID(),
    epoch,
    key,
    promise,
    resolve,
    timer: null,
  };
  authorization.timer = setTimeout(() => {
    if (pendingClientAuthorizations.get(key) !== authorization) return;
    resolveClientAuthorization(authorization, false);
  }, CLIENT_AUTHORIZATION_TIMEOUT_MS);
  pendingClientAuthorizations.set(key, authorization);
  try {
    client.postMessage({
      adapterId: adapter.adapterId,
      challenge: authorization.challenge,
      frameNonce: adapter.frameNonce,
      generation: adapter.generation,
      type: "cantrip-code-client-lineage-challenge-v2",
    });
  } catch {
    resolveClientAuthorization(authorization, false);
  }
  return promise;
}

async function authorizeAdapterRecoveryRequest(event, adapterId) {
  const clientId =
    (typeof event.clientId === "string" && event.clientId) ||
    (typeof event.replacesClientId === "string" && event.replacesClientId) ||
    "";
  if (!clientId) {
    return (
      event.request.mode === "navigate" &&
      typeof event.resultingClientId === "string" &&
      Boolean(event.resultingClientId)
    );
  }
  let client;
  try {
    client = await self.clients.get(clientId);
  } catch {
    return false;
  }
  if (eligibleTopLevelClient(client)) return true;
  return protectedCodeClient(client, adapterId) || protectedBlobClient(client);
}

async function authorizeRecoveredAdapterFetch(event, adapter) {
  if (await authorizeAdapterFetch(event, adapter)) return true;
  const clientId = typeof event.clientId === "string" ? event.clientId : "";
  const replacesClientId =
    typeof event.replacesClientId === "string" ? event.replacesClientId : "";
  const existingClientId = clientId || replacesClientId;
  if (!existingClientId || existingClientId === adapter.ownerClientId) {
    return false;
  }
  if (!(await authorizeAdapterClientByChallenge(adapter, existingClientId))) {
    return false;
  }
  const authorization = authorizeAdapterFetch(event, adapter);
  return typeof authorization === "boolean"
    ? authorization
    : await authorization;
}

async function proxyRequest(event, adapterId) {
  const request = event.request;
  let adapter = adapters.get(adapterId);
  let recovered = false;
  if (!adapter) {
    if (!(await authorizeAdapterRecoveryRequest(event, adapterId))) {
      void cancelRequestBody(
        request.body,
        "Protected Code recovery client unauthorized.",
      );
      return textResponse("The protected Code client is not authorized.", 403);
    }
    adapter = await waitForAdapterRegistration(adapterId);
    recovered = adapter !== null;
  }
  if (!adapter || adapter.retired || adapters.get(adapterId) !== adapter) {
    void cancelRequestBody(request.body, "Protected Code adapter unavailable.");
    return textResponse("The protected Code adapter is unavailable.", 503);
  }
  const authorization = recovered
    ? authorizeRecoveredAdapterFetch(event, adapter)
    : authorizeAdapterFetch(event, adapter);
  const authorized =
    typeof authorization === "boolean" ? authorization : await authorization;
  if (!authorized) {
    void cancelRequestBody(request.body, "Protected Code client unauthorized.");
    return textResponse("The protected Code client is not authorized.", 403);
  }
  if (activeRequestCount >= MAX_CONCURRENT_REQUESTS) {
    void cancelRequestBody(request.body, "Protected Code ingress is full.");
    return textResponse(
      "Too many protected Code requests are already in progress.",
      429,
    );
  }
  if (adapter.activeRequestCount >= MAX_CONCURRENT_ADAPTER_REQUESTS) {
    void cancelRequestBody(
      request.body,
      "Protected Code adapter ingress is full.",
    );
    return textResponse(
      "Too many requests for this protected Code adapter are already in progress.",
      429,
    );
  }
  activeRequestCount += 1;
  adapter.activeRequestCount += 1;
  let context = null;
  try {
    const requestId = crypto.randomUUID();
    context = createRequestContext(request, adapter, requestId);
    adapter.contexts.add(context);
    const body = await readRequestBody(request, context);
    context.throwIfFailed();
    const pageResponse = await deliverToPage(context, request, body);
    context.throwIfFailed();
    const response = validatePageResponse(pageResponse);
    const headers = new Headers(response.headers);
    headers.delete("content-length");
    headers.delete("transfer-encoding");
    let responseBody = response.body;
    if (
      response.body instanceof ArrayBuffer &&
      (headers.get("content-type") ?? "").toLowerCase().includes("text/html")
    ) {
      const decoder = new TextDecoder();
      const html = decoder.decode(response.body);
      const lineage =
        adapter.frameNonce && adapter.lineageToken
          ? `<meta name="cantrip-code-worker-lineage" content="${adapter.generation}:${adapter.frameNonce}:${adapter.lineageToken}">`
          : "";
      const shim = `${lineage}<script src="/cantrip-code-websocket-shim.js"></script>`;
      responseBody = textEncoder.encode(
        /<head(?:\s[^>]*)?>/iu.test(html)
          ? html.replace(/<head(?:\s[^>]*)?>/iu, (head) => `${head}${shim}`)
          : `${shim}${html}`,
      ).buffer;
      if (responseBody.byteLength > MAX_RESPONSE_BYTES) {
        throw new ProxyRequestError(
          "The protected Code response is too large.",
          502,
        );
      }
    }
    return new Response(responseBody, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  } catch (error) {
    const failure =
      error instanceof ProxyRequestError
        ? error
        : new ProxyRequestError("The protected Code request failed.", 502);
    context?.fail(failure);
    return textResponse(failure.message, failure.status);
  } finally {
    context?.dispose();
    if (context) adapter.contexts.delete(context);
    adapter.activeRequestCount = Math.max(0, adapter.activeRequestCount - 1);
    activeRequestCount = Math.max(0, activeRequestCount - 1);
  }
}

class ProxyRequestError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

function validatePageResponse(response) {
  if (!response || typeof response !== "object") {
    throw invalidPageResponse();
  }
  if (Object.prototype.hasOwnProperty.call(response, "error")) {
    if (typeof response.error !== "string") throw invalidPageResponse();
    throw new ProxyRequestError(response.error, 502);
  }
  if (
    !Number.isInteger(response.status) ||
    response.status < 200 ||
    response.status > 599 ||
    typeof response.statusText !== "string" ||
    /[\r\n]/u.test(response.statusText)
  ) {
    throw invalidPageResponse();
  }
  if (
    !response.headers ||
    typeof response.headers[Symbol.iterator] !== "function"
  ) {
    throw invalidPageResponse();
  }
  const headers = [];
  let headerBytes = 2;
  for (const entry of response.headers) {
    if (headers.length >= MAX_HEADER_COUNT) throw invalidPageResponse();
    if (!Array.isArray(entry) || entry.length !== 2) {
      throw invalidPageResponse();
    }
    const [name, value] = entry;
    if (
      typeof name !== "string" ||
      typeof value !== "string" ||
      name.length > 256 ||
      value.length > 8_192 ||
      !/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/u.test(name) ||
      /[\r\n]/u.test(value)
    ) {
      throw invalidPageResponse();
    }
    headerBytes += textEncoder.encode(`${name}: ${value}\r\n`).byteLength;
    if (headerBytes > MAX_HEADER_BYTES) throw invalidPageResponse();
    headers.push([name, value]);
  }
  if (response.body !== null && !(response.body instanceof ArrayBuffer)) {
    throw invalidPageResponse();
  }
  if (response.body?.byteLength > MAX_RESPONSE_BYTES) {
    throw new ProxyRequestError(
      "The protected Code response is too large.",
      502,
    );
  }
  const bodylessStatus = [204, 205, 304].includes(response.status);
  if (bodylessStatus && response.body?.byteLength) throw invalidPageResponse();
  return {
    body: bodylessStatus ? null : response.body,
    headers,
    status: response.status,
    statusText: response.statusText,
  };
}

function invalidPageResponse() {
  return new ProxyRequestError("The protected Code response was invalid.", 502);
}

function createRequestContext(request, adapter, requestId) {
  let cancelPosted = false;
  let delivered = false;
  let disposed = false;
  let failed = null;
  let pageReject = null;
  let pageSettled = false;
  let reader = null;
  let readerCancelled = false;
  const epoch = adapter.epoch;

  const cancelPage = () => {
    if (!delivered || pageSettled || cancelPosted) return;
    cancelPosted = true;
    try {
      adapter.port.postMessage({
        adapterId: adapter.adapterId,
        requestId,
        type: "cantrip-code-http-cancel-v1",
      });
    } catch {
      // The request is already terminal locally. Never retry cancellation.
    }
  };
  const cancelReader = async (reason) => {
    if (!reader || readerCancelled) return;
    readerCancelled = true;
    try {
      await reader.cancel(reason);
    } catch {
      // The local failure still owns the request even if stream cancel rejects.
    }
  };
  const fail = (error) => {
    if (failed) return failed;
    failed = error;
    void cancelReader(error.message);
    cancelPage();
    if (pageReject) {
      const reject = pageReject;
      pageReject = null;
      pageSettled = true;
      if (pending.get(requestId)?.context === context)
        pending.delete(requestId);
      reject(error);
    }
    return error;
  };
  const onAbort = () =>
    fail(
      new ProxyRequestError("The protected Code request was cancelled.", 502),
    );
  const timer = setTimeout(
    () =>
      fail(new ProxyRequestError("The protected Code request timed out.", 504)),
    REQUEST_DEADLINE_MS,
  );
  const context = {
    adapter,
    adapterId: adapter.adapterId,
    cancelReader,
    dispose() {
      if (disposed) return;
      disposed = true;
      clearTimeout(timer);
      request.signal.removeEventListener("abort", onAbort);
      if (pending.get(requestId)?.context === context)
        pending.delete(requestId);
    },
    epoch,
    fail,
    markDelivered(reject) {
      delivered = true;
      pageReject = reject;
    },
    receivePageResponse() {
      pageSettled = true;
      pageReject = null;
    },
    requestId,
    setReader(nextReader) {
      reader = nextReader;
      if (failed) void cancelReader(failed.message);
    },
    clearReader(currentReader) {
      if (reader === currentReader) reader = null;
    },
    throwIfFailed() {
      if (!failed && !adapterEpochIsCurrent(adapter, epoch)) {
        fail(
          new ProxyRequestError(
            "The protected Code workbench frame was superseded.",
            503,
          ),
        );
      }
      if (failed) throw failed;
    },
  };
  request.signal.addEventListener("abort", onAbort, { once: true });
  if (request.signal.aborted) onAbort();
  return context;
}

async function readRequestBody(request, context) {
  if (request.method === "GET" || request.method === "HEAD") return null;
  const declared = request.headers.get("content-length");
  const declaredLength = declared === null ? null : Number(declared);
  const reader = request.body?.getReader() ?? null;
  if (
    declaredLength !== null &&
    Number.isFinite(declaredLength) &&
    declaredLength > MAX_REQUEST_BYTES
  ) {
    if (reader) {
      context.setReader(reader);
      void context.cancelReader("The protected Code request is too large.");
      context.clearReader(reader);
      try {
        reader.releaseLock();
      } catch {
        // Cancellation may retain the lock until its pending read settles.
      }
    }
    throw new ProxyRequestError(
      "The protected Code request is too large.",
      413,
    );
  }
  if (!reader) return null;
  context.setReader(reader);
  const chunks = [];
  let byteLength = 0;
  try {
    while (true) {
      context.throwIfFailed();
      const chunk = await reader.read();
      context.throwIfFailed();
      if (chunk.done) break;
      if (!(chunk.value instanceof Uint8Array)) {
        throw new ProxyRequestError(
          "The protected Code request body was invalid.",
          400,
        );
      }
      byteLength += chunk.value.byteLength;
      if (byteLength > MAX_REQUEST_BYTES) {
        void context.cancelReader("The protected Code request is too large.");
        throw new ProxyRequestError(
          "The protected Code request is too large.",
          413,
        );
      }
      chunks.push(chunk.value.slice());
    }
  } finally {
    context.clearReader(reader);
    try {
      reader.releaseLock();
    } catch {
      // A concurrently cancelled read may release its lock asynchronously.
    }
  }
  const body = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body.buffer;
}

function deliverToPage(context, request, body) {
  return new Promise((resolve, reject) => {
    context.throwIfFailed();
    const adapter = context.adapter;
    if (adapter.retired || adapters.get(adapter.adapterId) !== adapter) {
      throw new ProxyRequestError(
        "The protected Code adapter is unavailable.",
        503,
      );
    }
    const entry = {
      adapter,
      context,
      receive(message) {
        if (pending.get(context.requestId) !== entry) return;
        pending.delete(context.requestId);
        context.receivePageResponse();
        resolve(message);
      },
    };
    pending.set(context.requestId, entry);
    context.markDelivered(reject);
    try {
      adapter.port.postMessage({
        adapterId: context.adapterId,
        body,
        headers: [...request.headers.entries()],
        method: request.method,
        requestId: context.requestId,
        type: "cantrip-code-http-request-v1",
        url: request.url,
      });
    } catch {
      const failure = new ProxyRequestError(
        "The protected Code request could not be delivered.",
        502,
      );
      context.fail(failure);
    }
  });
}

async function cancelRequestBody(body, reason) {
  if (!body) return;
  try {
    await body.cancel(reason);
  } catch {
    // The rejected request must not acquire a slot even if cancel fails.
  }
}

function textResponse(message, status) {
  return new Response(message, {
    status,
    headers: { "cache-control": "no-store", "content-type": "text/plain" },
  });
}

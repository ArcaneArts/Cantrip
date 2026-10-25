/** A renderer lifetime owns an origin-wide exclusive lock until its JavaScript
 * context ends. The lock is deliberately not released when React reconnects or
 * switches projects: components and in-flight callbacks can outlive an effect.
 * A newly granted lock is lifecycle evidence, not an elapsed-time inference. */
export interface WorkspaceRendererLifetime {
  rendererId: string;
  signal: AbortSignal;
  releaseConnection?: () => void;
}

/** The context lock outlives a React connection. Once its final connection is
 * disposed, any in-memory transfer lease has ended; the next connection must
 * claim a fresh attachment, even though the JavaScript context is unchanged. */
export function createWorkspaceRendererConnections(
  allocateId = () => crypto.randomUUID() as string,
) {
  const bindings = new WeakMap<
    WorkspaceRendererLifetime,
    { id: string; references: number }
  >();
  return (context: WorkspaceRendererLifetime): WorkspaceRendererLifetime => {
    context.signal.throwIfAborted();
    let binding = bindings.get(context);
    if (!binding) {
      binding = { id: allocateId(), references: 0 };
      bindings.set(context, binding);
    }
    binding.references++;
    let released = false;
    return {
      rendererId: binding.id,
      signal: context.signal,
      releaseConnection: () => {
        if (released) return;
        released = true;
        if (--binding.references === 0 && bindings.get(context) === binding)
          bindings.delete(context);
      },
    };
  };
}

export interface RendererLockHost {
  request(name: string, hold: () => Promise<void>): Promise<void>;
}

export function createWorkspaceRendererLifetimes(
  host: RendererLockHost,
  ended: AbortSignal,
  allocateId = () => crypto.randomUUID() as string,
) {
  const lifetimes = new Map<string, Promise<WorkspaceRendererLifetime>>();
  return (name: string): Promise<WorkspaceRendererLifetime> => {
    if (ended.aborted) return Promise.reject(ended.reason);
    const existing = lifetimes.get(name);
    if (existing) return existing;
    const lifetime = new Promise<WorkspaceRendererLifetime>(
      (resolve, reject) => {
        const controller = new AbortController();
        const end = () => {
          controller.abort(ended.reason);
          reject(ended.reason);
        };
        ended.addEventListener("abort", end, { once: true });
        // Never voluntarily release an acquired lifetime. The browser releases
        // it when the owning context is destroyed, including renderer crashes.
        const hold = async () => {
          if (ended.aborted) throw ended.reason;
          resolve({ rendererId: allocateId(), signal: controller.signal });
          await new Promise<void>(() => {});
        };
        void Promise.resolve()
          .then(() => host.request(name, hold))
          .catch((error) => {
            controller.abort(error);
            ended.removeEventListener("abort", end);
            reject(error);
            lifetimes.delete(name);
          });
      },
    );
    lifetimes.set(name, lifetime);
    return lifetime;
  };
}

let acquire: ReturnType<typeof createWorkspaceRendererLifetimes> | undefined;
const retainConnection = createWorkspaceRendererConnections();

export async function workspaceRendererLifetime(scope: {
  serverId: string;
  ownerId: string;
  workspaceId: string;
  windowId: string;
}): Promise<WorkspaceRendererLifetime> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(
      JSON.stringify([
        "workspace-renderer-v1",
        scope.serverId,
        scope.ownerId,
        scope.workspaceId,
        scope.windowId,
      ]),
    ),
  );
  const name = `cantrip-workspace-renderer:${Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
  if (!acquire) {
    const ended = new AbortController();
    window.addEventListener(
      "pagehide",
      () => {
        ended.abort(new Error("The workspace renderer lifetime has ended."));
      },
      { once: true },
    );
    // A BFCache restoration can revive an old JavaScript heap. Never reuse its
    // disposed controllers; start a new context and acquire ownership again.
    window.addEventListener("pageshow", (event) => {
      if (event.persisted) window.location.reload();
    });
    acquire = createWorkspaceRendererLifetimes(
      {
        request: (lockName, hold) =>
          navigator.locks.request(lockName, { mode: "exclusive" }, hold),
      },
      ended.signal,
    );
  }
  return retainConnection(await acquire(name));
}

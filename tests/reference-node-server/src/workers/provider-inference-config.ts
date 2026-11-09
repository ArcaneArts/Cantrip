import type { ServerRepository } from "../db/repository.js";
import type { WorkerCommandBus } from "./bridge.js";
import { workerInferenceStatusSchema } from "@cantrip/protocol";
import { serverLogger } from "../logger.js";

type Repository = Pick<
  ServerRepository,
  "readProviderInferenceCatalog" | "getWorker"
>;
type Reporter = (error: unknown, workerId?: string) => void;
interface Delivery {
  dirty: boolean;
  failures: number;
  run: () => Promise<void>;
  report: Reporter;
  workerId?: string;
  running: Promise<void> | null;
  timer: ReturnType<typeof setTimeout> | null;
}

/** Only undelivered worker metadata is retained. There is no semaphore or prompt queue here. */
class InferenceMetadataDelivery {
  private pending = new Map<string, Delivery>();
  private closed = false;

  schedule(
    key: string,
    run: Delivery["run"],
    report: Reporter,
    workerId?: string,
  ): void {
    if (this.closed) return;
    let delivery = this.pending.get(key);
    if (!delivery) {
      delivery = {
        dirty: true,
        failures: 0,
        run,
        report,
        workerId,
        running: null,
        timer: null,
      };
      this.pending.set(key, delivery);
    } else {
      delivery.dirty = true;
      delivery.run = run;
      delivery.report = report;
      if (delivery.timer) clearTimeout(delivery.timer);
      delivery.timer = null;
    }
    this.start(key, delivery);
  }

  private start(key: string, delivery: Delivery): void {
    if (this.closed || delivery.running || this.pending.get(key) !== delivery)
      return;
    delivery.running = (async () => {
      while (!this.closed && this.pending.get(key) === delivery) {
        delivery.dirty = false;
        try {
          await delivery.run();
          if (this.closed) return;
          delivery.failures = 0;
          if (delivery.dirty) continue;
          this.pending.delete(key);
          return;
        } catch (error) {
          if (this.closed) return;
          // A settlement/configuration wake can arrive while this attempt is
          // still awaiting its reply. Consume it now instead of burying the
          // fresh state behind the preceding attempt's retry timer.
          if (delivery.dirty) continue;
          if (delivery.failures++ === 0) {
            try {
              delivery.report(error, delivery.workerId);
            } catch {
              /* Diagnostics cannot undo a committed mutation. */
            }
          }
          const delay = Math.min(
            60_000,
            1_000 * 2 ** Math.min(delivery.failures - 1, 6),
          );
          delivery.timer = setTimeout(() => {
            delivery.timer = null;
            this.start(key, delivery);
          }, delay);
          delivery.timer.unref();
          return;
        }
      }
    })().finally(() => {
      delivery.running = null;
    });
  }

  async close(): Promise<void> {
    this.closed = true;
    const deliveries = [...this.pending.values()];
    this.pending.clear();
    for (const delivery of deliveries)
      if (delivery.timer) clearTimeout(delivery.timer);
    await Promise.allSettled(deliveries.map((delivery) => delivery.running));
  }
}

const deliveries = new WeakMap<object, InferenceMetadataDelivery>();
function deliveryFor(bridge: object): InferenceMetadataDelivery {
  let delivery = deliveries.get(bridge);
  if (!delivery) {
    delivery = new InferenceMetadataDelivery();
    deliveries.set(bridge, delivery);
  }
  return delivery;
}

/** Shares the existing coalesced retry/shutdown owner with provider settings. */
export function scheduleInferenceMetadataDelivery(
  bridge: object,
  key: string,
  run: () => Promise<void>,
  report: Reporter,
  workerId?: string,
): void {
  deliveryFor(bridge).schedule(key, run, report, workerId);
}
const defaultReporter: Reporter = (error, workerId) =>
  serverLogger.event(
    "warn",
    "Provider inference configuration delivery remains pending",
    {
      event: "inference.configuration.delivery-pending",
      subsystem: "worker-command",
      workerId,
      error: error instanceof Error ? error : new Error(String(error)),
    },
  );

/** Configuration delivery never grants a ticket or restarts a native process.
 * Calls coalesce and return after scheduling; HTTP disconnects do not cancel delivery. */
export async function synchronizeProviderInference(
  repository: Repository,
  bridge: Pick<WorkerCommandBus, "request">,
  ownerId: string,
  workerId: string,
  report: Reporter = defaultReporter,
): Promise<void> {
  deliveryFor(bridge).schedule(
    JSON.stringify([ownerId, workerId]),
    async () => {
      // This is authoritative ownership, not a connectivity preflight. Offline
      // workers still receive a real request and retry after its actual failure.
      if (!(await repository.getWorker(ownerId, workerId))) return;
      const catalog = await repository.readProviderInferenceCatalog(ownerId);
      const result = workerInferenceStatusSchema.parse(
        await bridge.request(
          workerId,
          { type: "inference.configure", ...catalog },
          { ownerId, timeoutMs: 30_000 },
        ),
      );
      if (
        result.workerId !== workerId ||
        result.ownerId !== ownerId ||
        result.providerCatalogRevision === undefined ||
        result.providerCatalogRevision < catalog.catalogRevision
      )
        throw new Error(
          "Provider inference configuration was not acknowledged by its worker scope.",
        );
      const acknowledged = new Map(
        result.pools.map((pool) => [pool.providerId, pool]),
      );
      for (const expected of catalog.configurations) {
        const actual = acknowledged.get(expected.providerId);
        if (
          (!actual &&
            result.providerCatalogRevision === catalog.catalogRevision) ||
          (actual &&
            actual.inferenceCatalogCreatedRevision <
              expected.inferenceCatalogCreatedRevision) ||
          (actual &&
            actual.inferenceCatalogCreatedRevision ===
              expected.inferenceCatalogCreatedRevision &&
            (actual.inferenceConfigRevision <
              expected.inferenceConfigRevision ||
              (actual.inferenceConfigRevision ===
                expected.inferenceConfigRevision &&
                actual.maxConcurrentInference !==
                  expected.maxConcurrentInference)))
        )
          throw new Error(
            "Provider inference configuration acknowledgement did not include the saved limit.",
          );
      }
    },
    report,
    workerId,
  );
}

/** A committed catalog mutation is not rolled back by an offline worker. */
export async function synchronizeAllProviderInference(
  repository: Repository & Pick<ServerRepository, "listWorkers">,
  bridge: Pick<WorkerCommandBus, "request">,
  ownerId: string,
  report: Reporter,
): Promise<void> {
  deliveryFor(bridge).schedule(
    JSON.stringify([ownerId, null]),
    async () => {
      const workers = await repository.listWorkers(ownerId);
      for (const { workerId } of workers)
        await synchronizeProviderInference(
          repository,
          bridge,
          ownerId,
          workerId,
          report,
        );
    },
    report,
  );
}

export async function closeProviderInferenceDelivery(
  bridge: object,
): Promise<void> {
  await deliveries.get(bridge)?.close();
}

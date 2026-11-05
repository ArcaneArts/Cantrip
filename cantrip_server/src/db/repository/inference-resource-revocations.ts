import { and, asc, eq } from "drizzle-orm";
import * as schema from "../schema.js";
import type { RepositoryDatabase } from "./database.js";

export const INFERENCE_RESOURCE_REVOCATION_CHANNEL =
  "cantrip_inference_resource_revocations";
export interface InferenceRevocationScope {
  ownerId: string;
  workerId: string;
}
type Observer = (scope: InferenceRevocationScope | null) => void;

/** Committed revocations only. No prompts, inference grants or completed history. */
export class InferenceResourceRevocationRepository {
  private readonly observers = new Set<Observer>();
  constructor(private readonly database: RepositoryDatabase) {}

  subscribe(observer: Observer): () => void {
    this.observers.add(observer);
    return () => {
      this.observers.delete(observer);
    };
  }

  receive(payload: string): void {
    let scope: InferenceRevocationScope | null = null;
    if (payload) {
      let value: unknown;
      try {
        value = JSON.parse(payload);
      } catch {
        return;
      }
      if (
        !value ||
        typeof value !== "object" ||
        !("ownerId" in value) ||
        typeof value.ownerId !== "string" ||
        !("workerId" in value) ||
        typeof value.workerId !== "string"
      )
        return;
      scope = { ownerId: value.ownerId, workerId: value.workerId };
    }
    for (const observer of this.observers) {
      try {
        observer(scope);
      } catch {
        /* Delivery remains durable after an observer failure. */
      }
    }
  }

  async scopes(): Promise<InferenceRevocationScope[]> {
    return this.database
      .selectDistinct({
        ownerId: schema.inferenceResourceRevocations.ownerId,
        workerId: schema.inferenceResourceRevocations.workerId,
      })
      .from(schema.inferenceResourceRevocations)
      .innerJoin(
        schema.workers,
        and(
          eq(schema.workers.id, schema.inferenceResourceRevocations.workerId),
          eq(
            schema.workers.ownerId,
            schema.inferenceResourceRevocations.ownerId,
          ),
        ),
      );
  }

  async pending(ownerId: string, workerId: string) {
    return this.database
      .select({
        id: schema.inferenceResourceRevocations.id,
        target: schema.inferenceResourceRevocations.target,
      })
      .from(schema.inferenceResourceRevocations)
      .innerJoin(
        schema.workers,
        and(
          eq(schema.workers.id, schema.inferenceResourceRevocations.workerId),
          eq(
            schema.workers.ownerId,
            schema.inferenceResourceRevocations.ownerId,
          ),
        ),
      )
      .where(
        and(
          eq(schema.inferenceResourceRevocations.ownerId, ownerId),
          eq(schema.inferenceResourceRevocations.workerId, workerId),
        ),
      )
      .orderBy(
        asc(schema.inferenceResourceRevocations.createdAt),
        asc(schema.inferenceResourceRevocations.id),
      )
      .limit(100);
  }

  async acknowledge(
    ownerId: string,
    workerId: string,
    id: string,
  ): Promise<void> {
    await this.database
      .delete(schema.inferenceResourceRevocations)
      .where(
        and(
          eq(schema.inferenceResourceRevocations.id, id),
          eq(schema.inferenceResourceRevocations.ownerId, ownerId),
          eq(schema.inferenceResourceRevocations.workerId, workerId),
        ),
      );
  }
}

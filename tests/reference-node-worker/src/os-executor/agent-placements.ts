import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
  cantripOsExecutionSchema,
  type CantripOsExecution,
} from "@cantrip/protocol";

/** A captured chat never falls through to a host runtime after worker restart.
 * This is private worker provenance; canonical placement remains on the Server. */
export class OsAgentPlacements {
  constructor(private readonly directory: string) {}
  resolve(
    identity: {
      serverId: string;
      ownerId: string;
      workerId: string;
      chatId?: string | null;
    },
    proposed?: CantripOsExecution,
  ): CantripOsExecution | undefined {
    if (!identity.chatId) {
      if (proposed)
        throw new Error(
          "An OS agent runtime requires an admitted chat identity.",
        );
      return undefined;
    }
    const key = createHash("sha256")
      .update(
        JSON.stringify([
          identity.serverId,
          identity.ownerId,
          identity.workerId,
          identity.chatId,
        ]),
      )
      .digest("hex");
    const file = path.join(
      this.directory,
      "os-agent-placements",
      `${key}.json`,
    );
    let existing: CantripOsExecution | undefined;
    try {
      existing = cantripOsExecutionSchema.parse(
        JSON.parse(readFileSync(file, "utf8")),
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (!proposed) return existing;
    const placement = cantripOsExecutionSchema.parse(proposed);
    if (
      placement.scope.ownerId !== identity.ownerId ||
      placement.scope.workerId !== identity.workerId
    )
      throw new Error("The OS runtime belongs to a different owner or worker.");
    if (existing) {
      if (!isDeepStrictEqual(existing, placement))
        throw new Error(
          "This chat already captured a different OS placement; its runtime cannot be retargeted.",
        );
      return existing;
    }
    mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    writeFileSync(file, JSON.stringify(placement), { flag: "wx", mode: 0o600 });
    return placement;
  }
}

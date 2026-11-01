import { NbtTag, type NbtNode } from "../types.js";
import type { NbtReadModel } from "../view/types.js";
import { nbtDocumentError } from "../document/engine.js";
import { NbtSearchResults } from "./results.js";
import {
  numericMatcher,
  isArray,
  literalMatcher,
  NBT_TYPE_NAMES,
  nbtScalarText,
  pathChunks,
  pathTail,
  streamMatches,
  textChunks,
} from "./text.js";
import type {
  NbtSearchField,
  NbtSearchQuery,
  NbtSearchStatus,
} from "./types.js";

type Job = {
  id: string;
  model: NbtReadModel;
  controller: AbortController;
  status: NbtSearchStatus;
  results?: NbtSearchResults;
  done: Promise<void>;
  lastEmit: number;
  timer?: ReturnType<typeof setTimeout>;
};
export class NbtDocumentSearch {
  private current: Job | undefined;
  get currentId() {
    return this.current?.id;
  }
  constructor(
    private provider: NbtReadModel | (() => NbtReadModel),
    private binding: string,
    private publish: (status: NbtSearchStatus) => void,
  ) {}
  start(id: string, query: NbtSearchQuery) {
    if (
      !id ||
      id.length > 128 ||
      !query.text ||
      query.text.length > 4096 ||
      !query.fields.length ||
      query.fields.some(
        (field) => !["name", "value", "type", "path"].includes(field),
      )
    )
      throw new Error("Invalid NBT search query.");
    const previous = this.current;
    if (previous) {
      previous.controller.abort();
      if (previous.timer !== undefined) clearTimeout(previous.timer);
      void previous.done.then(() => previous.results?.close()).catch(() => {});
    }
    const job: Job = {
      id,
      model:
        typeof this.provider === "function" ? this.provider() : this.provider,
      controller: new AbortController(),
      status: { id, state: "searching", count: 0, scannedNodes: 0 },
      done: Promise.resolve(),
      lastEmit: 0,
    };
    this.current = job;
    this.emit(job, true);
    job.done = this.run(job, structuredClone(query));
    void job.done.catch(() => {});
    return { ...job.status };
  }
  private emit(job: Job, force = false) {
    if (this.current !== job) return;
    const now = performance.now(),
      elapsed = now - job.lastEmit;
    if (force || elapsed >= 100) {
      if (job.timer !== undefined) clearTimeout(job.timer);
      job.timer = undefined;
      job.lastEmit = now;
      job.status.count = job.results?.count ?? 0;
      this.publish({ ...job.status });
    } else if (job.timer === undefined) {
      // A one-shot flush publishes results even while waiting for more indexed bytes.
      job.timer = setTimeout(() => {
        job.timer = undefined;
        this.emit(job, true);
      }, 100 - elapsed);
    }
  }

  private async nodeMatches(
    model: NbtReadModel,
    node: NbtNode,
    query: NbtSearchQuery,
    signal: AbortSignal,
    test: ReturnType<typeof literalMatcher>,
    numeric: ReturnType<typeof numericMatcher>,
  ) {
    const matched: NbtSearchField[] = [],
      has = (field: NbtSearchField) => query.fields.includes(field);
    if (
      has("name") &&
      (node.name
        ? await streamMatches(
            textChunks(model, node.name, signal),
            query,
            signal,
          )
        : node.parent !== null && test(String(node.ordinal)))
    )
      matched.push("name");
    if (
      has("type") &&
      (test(NBT_TYPE_NAMES[node.type]!) || test(NbtTag[node.type]!))
    )
      matched.push("type");
    if (
      has("path") &&
      (await streamMatches(pathChunks(model, node, signal), query, signal))
    )
      matched.push("path");
    if (has("value")) {
      if (
        node.type === NbtTag.String &&
        !query.exactNumber &&
        (await streamMatches(
          textChunks(model, node.data!, signal),
          query,
          signal,
        ))
      )
        matched.push("value");
      else if (node.type >= NbtTag.Byte && node.type <= NbtTag.Double) {
        const { value } = await model.scalar(node, signal);
        if (query.exactNumber ? numeric(value) : test(nbtScalarText(value)))
          matched.push("value");
      }
    }
    return matched;
  }
  private async arrayMatches(
    job: Job,
    node: NbtNode,
    query: NbtSearchQuery,
    test: ReturnType<typeof literalMatcher>,
    numeric: ReturnType<typeof numericMatcher>,
  ) {
    const model = job.model;
    const signal = job.controller.signal,
      has = (field: NbtSearchField) => query.fields.includes(field),
      path = has("path")
        ? await pathTail(model, node, query, signal)
        : undefined;
    const elementType =
        node.type === NbtTag.ByteArray
          ? NbtTag.Byte
          : node.type === NbtTag.IntArray
            ? NbtTag.Int
            : NbtTag.Long,
      typeMatches = has("type") && test(NBT_TYPE_NAMES[elementType]!);
    const maxDigits = String(Math.max(0, (node.length ?? 0) - 1)).length;
    const integerText = /^[+-]?[0-9]+$/u.test(query.text.trim()),
      integer = integerText ? BigInt(query.text.trim()) : undefined;
    const minimum =
        elementType === NbtTag.Byte
          ? -128n
          : elementType === NbtTag.Int
            ? -2147483648n
            : -9223372036854775808n,
      maximum = -minimum - 1n;
    const expected = Number(query.text.trim());
    const exactPossible =
      elementType === NbtTag.Long
        ? integer !== undefined && integer >= minimum && integer <= maximum
        : Number.isInteger(expected) &&
          expected >= Number(minimum) &&
          expected <= Number(maximum) &&
          numeric(expected);
    const namesPossible =
        has("name") &&
        query.text.length <= maxDigits &&
        /^[0-9]+$/u.test(query.text),
      valuesPossible =
        has("value") &&
        (query.exactNumber
          ? exactPossible
          : query.text.length <= String(minimum).length &&
            /^-?[0-9]*$/u.test(query.text)),
      pathsPossible = Boolean(
        path && (path.matched || /[0-9/]$/u.test(query.text)),
      );
    if (!namesPossible && !valuesPossible && !typeMatches && !pathsPossible)
      return;
    for (let offset = 0; offset < (node.length ?? 0); offset += 4096) {
      await model.work(signal);
      const count = Math.min(4096, node.length! - offset),
        values = valuesPossible
          ? await model.array(node.id, offset, count, signal)
          : undefined;
      let runStart = offset,
        runCount = 0,
        runFields: NbtSearchField[] = [];
      const flush = async () => {
        if (runCount)
          await job.results!.appendRange(
            node.id,
            runStart,
            runCount,
            runFields,
          );
        runCount = 0;
      };
      for (let i = 0; i < count; i++) {
        signal.throwIfAborted();
        const at = offset + i,
          matched: NbtSearchField[] = [];
        if (namesPossible && test(String(at))) matched.push("name");
        if (typeMatches) matched.push("type");
        if (
          pathsPossible &&
          path &&
          (path.matched || test(path.tail + "/" + at))
        )
          matched.push("path");
        if (
          values &&
          (query.exactNumber
            ? numeric(values[i]!)
            : test(nbtScalarText(values[i]!)))
        )
          matched.push("value");
        if (matched.length && runCount && matched.join() === runFields.join())
          runCount++;
        else {
          await flush();
          runStart = at;
          runFields = matched;
          if (matched.length) runCount = 1;
        }
      }
      await flush();
      this.emit(job);
    }
  }
  private async run(job: Job, query: NbtSearchQuery) {
    const model = job.model;
    const signal = job.controller.signal,
      test = literalMatcher(query),
      numeric = numericMatcher(query.text);
    try {
      job.results = await NbtSearchResults.open(
        this.binding + "/search/" + job.id,
      );
      signal.throwIfAborted();
      if (model.walkNodes) {
        for await (const nodes of model.walkNodes(query.scope, signal)) {
          for (const node of nodes) {
            signal.throwIfAborted();
            const matched = await this.nodeMatches(
              model,
              node,
              query,
              signal,
              test,
              numeric,
            );
            if (matched.length)
              await job.results.append(node.id, undefined, matched);
            if (isArray(node))
              await this.arrayMatches(job, node, query, test, numeric);
            job.status.scannedNodes++;
          }
          this.emit(job);
        }
        await model.validated(signal);
        signal.throwIfAborted();
        job.status.state = "complete";
        this.emit(job, true);
        return;
      }
      let cursor = query.scope ? Number(query.scope.slice(5)) : 0;
      if (!Number.isSafeInteger(cursor) || cursor < 0)
        throw new Error("Invalid search scope.");
      for (;;) {
        await model.work(signal);
        const revision = model.changeRevision(),
          status = model.snapshot(),
          scope = query.scope ? await model.getNode(query.scope) : undefined;
        if (query.scope && !scope)
          throw new Error("Search scope is unavailable.");
        const nodes = await model.scanNodes(cursor, 64);
        let finishedScope = false;
        const inScope = async (node: NbtNode) => {
          let parent = node.parent;
          for (let depth = 0; parent !== null && depth <= 4096; depth++) {
            if (parent === scope!.id) return true;
            parent = (await model.getNode(parent))?.parent ?? null;
          }
          return false;
        };
        for (const node of nodes) {
          signal.throwIfAborted();
          if (
            scope &&
            node.id !== scope.id &&
            ((scope.end !== null && node.start >= scope.end) ||
              ![NbtTag.List, NbtTag.Compound].includes(scope.type) ||
              (scope.end === null && !(await inScope(node))))
          ) {
            finishedScope = true;
            break;
          }
          const matched = await this.nodeMatches(
            model,
            node,
            query,
            signal,
            test,
            numeric,
          );
          if (matched.length)
            await job.results.append(node.id, undefined, matched);
          if (isArray(node))
            await this.arrayMatches(job, node, query, test, numeric);
          job.status.scannedNodes++;
          cursor++;
        }
        this.emit(job);
        if (
          finishedScope ||
          (cursor >= status.nodes && status.state === "complete")
        )
          break;
        if (cursor >= model.snapshot().nodes) {
          if (["error", "closed"].includes(model.snapshot().state))
            throw new Error(
              model.snapshot().error?.message ?? "NBT document is unavailable.",
            );
          await model.waitForChange(revision, signal);
        }
      }
      await model.validated(signal);
      signal.throwIfAborted();
      job.status.state = "complete";
      this.emit(job, true);
    } catch (error) {
      job.status.state = signal.aborted ? "cancelled" : "error";
      if (!signal.aborted) job.status.error = nbtDocumentError(error);
      this.emit(job, true);
    } finally {
      if (signal.aborted) {
        if (job.timer !== undefined) clearTimeout(job.timer);
        await job.results?.close().catch(() => {});
        job.results = undefined;
      }
    }
  }
  async results(
    id: string,
    offset: number,
    limit: number,
    signal?: AbortSignal,
  ) {
    const job = this.current;
    if (!job || job.id !== id) throw new Error("NBT search was replaced.");
    return job.results ? job.results.read(offset, limit, signal) : [];
  }
  async cancel(id: string) {
    const job = this.current;
    if (!job || job.id !== id) return false;
    job.controller.abort();
    await job.done;
    await job.results?.close();
    job.results = undefined;
    // A newer search may start while encrypted result cleanup is awaiting I/O.
    // Its owner must retain this context instead of deleting the replacement.
    if (this.current !== job) return false;
    this.current = undefined;
    return true;
  }
  async close() {
    if (this.current) await this.cancel(this.current.id);
  }
}

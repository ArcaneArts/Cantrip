import {
  NbtError,
  NbtTag,
  assertRange,
  type NbtNode,
  type NbtSpan,
} from "../types.js";
import type { NbtDocumentEngine } from "../document/engine.js";
import type { NbtRecoveryEvent, NbtRecoveryWriter } from "../recovery/types.js";
import { NbtEditData } from "./data.js";
import { NbtEditView, wrapCopy } from "./model.js";
import { NbtPersistentMap, NbtSequence } from "./persistent.js";
import {
  nbtArray,
  nbtArrayType,
  nbtContainer,
  nbtParseScalar,
  nbtStringBytes,
  nbtValueType,
} from "./validate.js";
import type {
  NbtEditState,
  NbtEditRecord,
  NbtEditOperation,
  NbtEditValue,
  NbtEditStatus,
  NbtCopy,
  NbtSerializableModel,
  NbtChildPart,
  NbtArrayPart,
  NbtPendingSave,
  NbtSaveTarget,
} from "./types.js";
interface History {
  state: NbtEditState;
  label: string;
}
/** Worker-owned edit journal, persistent undo roots, baseline version and save acknowledgement. */
export class NbtDocumentSession {
  private initialVersion: string;
  get canExportOriginal() {
    return (
      this.state === this.initial &&
      this.version === this.initialVersion &&
      !this.uncertain
    );
  }
  private initial: NbtEditState = {
    nodes: 0,
    records: new NbtPersistentMap(),
    body: new NbtPersistentMap(),
  };
  private state = this.initial;
  private saved = this.initial;
  private initialized = false;
  private undoStack: History[] = [];
  private redoStack: History[] = [];
  private copies = new Map<string, NbtCopy>();
  private sequence = 0;
  private createdCopies: string[] | undefined;
  private revision = 0;
  private tail = Promise.resolve();
  private closed = false;
  private uncertain = false;
  private journal = 0;
  private restoring = false;
  private saving:
    | (NbtPendingSave & {
        state: NbtEditState;
        view: NbtSerializableModel;
        suspended?: boolean;
      })
    | undefined;
  private constructor(
    readonly baseline: NbtDocumentEngine,
    readonly data: NbtEditData,
    private version: string,
    private publish: (status: NbtEditStatus) => void,
    private recovery?: NbtRecoveryWriter,
  ) {
    this.initialVersion = version;
  }
  static async open(
    baseline: NbtDocumentEngine,
    version: string,
    publish: (status: NbtEditStatus) => void = () => {},
    recovery?: NbtRecoveryWriter,
  ) {
    return new NbtDocumentSession(
      baseline,
      await NbtEditData.open(baseline, baseline.binding),
      version,
      publish,
      recovery,
    );
  }
  snapshot(): NbtEditStatus {
    return {
      revision: this.revision,
      dirty: this.state !== this.saved || this.uncertain,
      canUndo: Boolean(this.undoStack.length),
      canRedo: Boolean(this.redoStack.length),
      version: this.version,
      saving: Boolean(this.saving && !this.saving.suspended),
      pendingSaveId: this.saving?.id,
      ...(this.saving ? { pendingSave: this.saveSnapshot() } : {}),
      uncertain: this.uncertain,
    };
  }
  private saveSnapshot(): NbtPendingSave {
    const save = this.saving!;
    return {
      id: save.id,
      version: save.version,
      revision: save.revision,
      ...(save.target ? { target: { ...save.target } } : {}),
      ...(save.metadata ? { metadata: { ...save.metadata } } : {}),
    };
  }
  private emit() {
    this.publish(this.snapshot());
  }
  view(): NbtSerializableModel {
    return this.state === this.initial
      ? this.baseline
      : new NbtEditView(this.baseline, this.state, this.data, this.copies);
  }
  private logical(state = this.state) {
    return new NbtEditView(this.baseline, state, this.data, this.copies);
  }
  private check(signal?: AbortSignal) {
    if (this.closed) throw new NbtError(0, "NBT editing session is closed");
    signal?.throwIfAborted();
  }
  private serial<T>(run: () => Promise<T>) {
    const result = this.tail.then(() => {
      this.check();
      return run();
    });
    this.tail = result.then(
      () => {},
      () => {},
    );
    return result;
  }
  private async ready(signal: AbortSignal) {
    await this.baseline.validated(signal);
    this.check(signal);
    if (!this.initialized) {
      this.initial = { ...this.initial, nodes: this.baseline.snapshot().nodes };
      this.state = this.initial;
      this.saved = this.initial;
      this.initialized = true;
    }
    if (!this.restoring) await this.recovery?.prepare(signal);
  }
  private async checkpoint(event: NbtRecoveryEvent) {
    if (this.restoring) return;
    if (this.recovery) await this.recovery.append(event);
    else await this.data.journal(++this.journal, { version: 1, ...event });
  }
  attachRecovery(writer: NbtRecoveryWriter) {
    if (
      this.recovery ||
      this.initialized ||
      this.revision ||
      this.saving ||
      this.closed
    )
      throw new NbtError(
        0,
        "Only an unedited replacement can acquire NBT recovery",
      );
    this.recovery = writer;
  }
  /** Replay before publishing the session to views. Baseline bytes, node ID
   * reservations, undo roots and saved roots all retain their original meaning. */
  async restore(
    events: AsyncIterable<NbtRecoveryEvent>,
    signal = new AbortController().signal,
  ) {
    if (
      this.revision ||
      this.initialized ||
      this.snapshot().pendingSaveId ||
      this.restoring
    )
      throw new NbtError(0, "NBT recovery requires a new editing session");
    this.restoring = true;
    try {
      await this.ready(signal);
      for await (const event of events) {
        this.check(signal);
        if (!event || typeof event.kind !== "string")
          throw new NbtError(0, "Invalid NBT recovery operation");
        switch (event.kind) {
          case "apply": {
            if (
              !Number.isSafeInteger(event.allocationStart) ||
              event.allocationStart < this.sequence ||
              !Number.isSafeInteger(event.allocationEnd) ||
              event.allocationEnd < event.allocationStart
            )
              throw new NbtError(0, "Invalid NBT recovery node reservation");
            this.sequence = event.allocationStart;
            const revision = this.revision;
            await this.apply(event.operations, revision, signal, event.label);
            if (
              this.sequence !== event.allocationEnd ||
              this.revision !== revision + 1
            )
              throw new NbtError(
                0,
                "NBT recovery operation does not match its recorded result",
              );
            break;
          }
          case "undo":
            if (!this.undoStack.length)
              throw new NbtError(0, "NBT recovery has no operation to undo");
            await this.undo(signal);
            break;
          case "redo":
            if (!this.redoStack.length)
              throw new NbtError(0, "NBT recovery has no operation to redo");
            await this.redo(signal);
            break;
          case "save.begin":
            await this.beginSave(event.id, signal, event.target);
            break;
          case "save.ready":
            await this.prepareSave(event.id, event.metadata);
            break;
          case "save.ack":
            await this.acknowledgeSave(event.id, event.version);
            break;
          case "save.fail":
            if (this.saving?.id !== event.id)
              throw new NbtError(0, "NBT recovery references an unknown save");
            await this.failSave(event.id, event.uncertain, event.retain);
            break;
          default:
            throw new NbtError(0, "Unsupported NBT recovery operation");
        }
      }
      // A crashed renderer cannot certify that its pending external write did
      // not commit. Receipt reconciliation must resolve this state after reload.
      if (this.saving) {
        this.saving.suspended = true;
        this.uncertain = true;
      }
      this.emit();
    } finally {
      this.restoring = false;
    }
  }
  private record(state: NbtEditState, id: string, patch: NbtEditRecord) {
    return {
      ...state,
      records: state.records.set(id, { ...state.records.get(id), ...patch }),
    };
  }
  private async mark(
    state: NbtEditState,
    view: NbtEditView,
    id: string,
    delta: number,
    body = true,
  ) {
    if (!Number.isSafeInteger(state.nodes + delta) || state.nodes + delta < 1)
      throw new NbtError(0, "Logical tag count exceeds supported addressing");
    state = { ...state, nodes: state.nodes + delta };
    let current: string | null = id,
      first = true;
    for (let depth = 0; current !== null; depth++) {
      if (depth > 4096) throw new NbtError(0, "NBT ancestor budget exceeded");
      const node = await view.getNode(current);
      if (!node) throw new NbtError(0, "Edited ancestor is unavailable");
      if (body || !first)
        state = { ...state, body: state.body.set(current, true) };
      if (delta)
        state = this.record(state, current, {
          count: (await view.count(current)) + delta,
        });
      current = node.parent;
      first = false;
    }
    return state;
  }
  private async node(view: NbtEditView, id: string) {
    const node = await view.getNode(id);
    if (!node) throw new NbtError(0, "The selected tag is no longer available");
    return node;
  }
  private async sameName(
    view: NbtSerializableModel,
    span: NbtSpan | null,
    text: string,
    signal: AbortSignal,
  ) {
    if (!span) return false;
    let at = span.offset,
      used = 0;
    while (at < span.offset + span.length) {
      const page = await view.text(
        { ...span, offset: at, length: span.offset + span.length - at },
        4096,
        signal,
      );
      if (text.slice(used, used + page.text.length) !== page.text) return false;
      used += page.text.length;
      at = page.nextByte;
      if (used > text.length) return false;
    }
    return used === text.length;
  }
  private async unique(
    view: NbtEditView,
    parent: NbtNode,
    name: string,
    exclude: string | undefined,
    signal: AbortSignal,
  ) {
    for (let at = 0; at < parent.childCount; at += 128) {
      for (const child of await view.getChildren(parent.id, at, 128))
        if (
          child.id !== exclude &&
          (await this.sameName(view, child.name, name, signal))
        )
          throw new NbtError(0, "A property with that name already exists");
      await view.work(signal, false);
    }
  }
  private async name(text: string, signal: AbortSignal) {
    signal.throwIfAborted();
    const bytes = nbtStringBytes(text, this.baseline.encoding);
    try {
      return await this.data.append(bytes);
    } finally {
      bytes.fill(0);
    }
  }
  private async arrayPart(type: NbtTag, values: string[], signal: AbortSignal) {
    if (values.length > 4096)
      throw new NbtError(
        0,
        "Array changes are limited to 4096 inserted values per batch",
      );
    const scalarType = nbtArrayType(type),
      width =
        scalarType === NbtTag.Byte ? 1 : scalarType === NbtTag.Int ? 4 : 8,
      bytes = new Uint8Array(values.length * width),
      view = new DataView(bytes.buffer);
    try {
      for (let i = 0; i < values.length; i++) {
        signal.throwIfAborted();
        const value = nbtParseScalar(scalarType, values[i]!);
        if (width === 1) view.setInt8(i, Number(value));
        else if (width === 4) view.setInt32(i * 4, Number(value), true);
        else view.setBigInt64(i * 8, value as bigint, true);
      }
      const span = await this.data.append(bytes);
      return NbtSequence.from<NbtArrayPart>(
        { kind: "bytes", span, type },
        values.length,
      );
    } finally {
      bytes.fill(0);
    }
  }
  private async build(
    state: NbtEditState,
    value: NbtEditValue,
    parent: string | null,
    name: NbtSpan | null,
    signal: AbortSignal,
    budget: { nodes: number },
    id = "edit:" + ++this.sequence,
  ): Promise<{ state: NbtEditState; id: string; count: number }> {
    this.check(signal);
    if (++budget.nodes > 4096)
      throw new NbtError(
        0,
        "New subtrees are limited to 4096 tags per transaction",
      );
    nbtValueType(value.type);
    const node: NbtNode = {
        id,
        parent,
        ordinal: 0,
        type: value.type,
        name,
        start: 0,
        payload: 0,
        end: 0,
        childCount: 0,
      },
      record: NbtEditRecord = { created: node, count: 1 };
    let count = 1;
    if (value.type === NbtTag.String) {
      record.text = await this.name(value.value ?? "", signal);
      node.data = record.text;
    } else if (value.type >= NbtTag.Byte && value.type <= NbtTag.Double)
      record.scalar = nbtParseScalar(value.type, value.value ?? "0");
    else if (nbtArray(value.type)) {
      record.array = await this.arrayPart(
        value.type,
        value.values ?? [],
        signal,
      );
      node.length = record.array.length;
    } else {
      const ids: string[] = [],
        entries =
          value.type === NbtTag.Compound
            ? (value.children ?? [])
            : (value.items ?? []).map((tag) => ({ name: "", tag }));
      if (entries.length > 4096)
        throw new NbtError(0, "New child batches are limited to 4096 tags");
      const names = new Set<string>();
      let elementType = value.elementType ?? NbtTag.End;
      if (value.type === NbtTag.List) {
        if (elementType === NbtTag.End && entries.length)
          elementType = entries[0]!.tag.type;
        if (
          !Number.isInteger(elementType) ||
          elementType < 0 ||
          elementType > NbtTag.LongArray ||
          (entries.length && elementType === NbtTag.End)
        )
          throw new NbtError(0, "Invalid list element type");
        node.elementType = elementType;
      }
      for (const entry of entries) {
        if (value.type === NbtTag.Compound) {
          if (names.has(entry.name))
            throw new NbtError(
              0,
              "New duplicate compound names are not allowed",
            );
          names.add(entry.name);
        } else if (entry.tag.type !== elementType)
          throw new NbtError(
            0,
            "List element type does not match its declaration",
          );
        const childName =
            value.type === NbtTag.Compound
              ? await this.name(entry.name, signal)
              : null,
          built = await this.build(
            state,
            entry.tag,
            id,
            childName,
            signal,
            budget,
          );
        state = built.state;
        ids.push(built.id);
        count += built.count;
      }
      node.childCount = ids.length;
      if (value.type === NbtTag.List) node.length = ids.length;
      record.children = NbtSequence.from<NbtChildPart>(
        { kind: "ids", ids },
        ids.length,
      );
    }
    record.count = count;
    state = this.record(state, id, record);
    return { state, id, count };
  }
  private async operation(
    state: NbtEditState,
    operation: NbtEditOperation,
    signal: AbortSignal,
    budget: { nodes: number },
  ): Promise<{ state: NbtEditState; selection: string }> {
    const view = this.logical(state);
    if (operation.type === "insert" || operation.type === "duplicate") {
      const parent = await this.node(view, operation.parent);
      if (!nbtContainer(parent.type))
        throw new NbtError(0, "New tags require a compound or list");
      assertRange(operation.index, 0);
      if (operation.index > parent.childCount)
        throw new NbtError(0, "Insertion index exceeds container length");
      const source =
          operation.type === "duplicate"
            ? await this.node(view, operation.id)
            : undefined,
        type =
          source?.type ??
          (operation as Extract<NbtEditOperation, { type: "insert" }>).value
            .type;
      nbtValueType(type);
      let name: NbtSpan | null = null;
      if (parent.type === NbtTag.Compound) {
        if (operation.name === undefined)
          throw new NbtError(0, "Enter a property name");
        await this.unique(view, parent, operation.name, undefined, signal);
        name = await this.name(operation.name, signal);
      } else if (parent.childCount || parent.elementType !== NbtTag.End) {
        if (type !== parent.elementType)
          throw new NbtError(
            0,
            "List element type does not match its declaration",
          );
      }
      let id: string, count: number;
      if (operation.type === "insert") {
        const built = await this.build(
          state,
          operation.value,
          parent.id,
          name,
          signal,
          budget,
        );
        state = built.state;
        id = built.id;
        count = built.count;
      } else {
        const frozen = this.viewOf(state),
          prefix = "copy:" + ++this.sequence + "/",
          slash = source!.id.indexOf("/"),
          sourcePrefix = source!.id.startsWith("copy:")
            ? source!.id.slice(0, slash + 1) +
              (source!.id.slice(slash + 1).startsWith("r:") ? "r:" : "")
            : "",
          copy: NbtCopy = {
            prefix,
            sourcePrefix,
            root: "",
            parent: parent.id,
            view: frozen,
          };
        id = wrapCopy(copy, source!.id);
        copy.root = id.slice(prefix.length);
        this.copies.set(prefix, copy);
        this.createdCopies?.push(prefix);
        count = await frozen.count(source!.id);
        state = this.record(state, id, { name, count });
      }
      const resolved = (await view.resolve(parent.id))!,
        children = view
          .childrenSequence(resolved)
          .splice(
            operation.index,
            0,
            NbtSequence.from<NbtChildPart>({ kind: "ids", ids: [id] }, 1),
          );
      state = this.record(state, parent.id, {
        children,
        ...(parent.type === NbtTag.List && parent.elementType === NbtTag.End
          ? { elementType: type }
          : {}),
      });
      state = await this.mark(state, view, parent.id, count);
      return { state, selection: id };
    }
    const node = await this.node(view, operation.id),
      resolved = (await view.resolve(node.id))!;
    if (operation.type === "delete") {
      if (node.parent === null)
        throw new NbtError(0, "The document root cannot be deleted");
      const parent = (await view.resolve(node.parent))!,
        count = await view.count(node.id),
        children = view.childrenSequence(parent).splice(node.ordinal, 1);
      state = this.record(state, node.parent, { children });
      state = await this.mark(state, view, node.parent, -count);
      return { state, selection: node.parent };
    }
    if (operation.type === "rename") {
      if (!node.name)
        throw new NbtError(
          0,
          "This tag has no name in its container or encoding profile",
        );
      if (await this.sameName(view, node.name, operation.name, signal))
        return { state, selection: node.id };
      if (node.parent !== null)
        await this.unique(
          view,
          await this.node(view, node.parent),
          operation.name,
          node.id,
          signal,
        );
      state = this.record(state, node.id, {
        name: await this.name(operation.name, signal),
      });
      state = await this.mark(state, view, node.id, 0, false);
      return { state, selection: node.id };
    }
    if (operation.type === "value") {
      if (node.type === NbtTag.String) {
        if (await this.sameName(view, node.data!, operation.value, signal))
          return { state, selection: node.id };
        state = this.record(state, node.id, {
          text: await this.name(operation.value, signal),
        });
      } else {
        const scalar = nbtParseScalar(node.type, operation.value),
          previous = await view.scalar(node, signal);
        if (Object.is(scalar, previous.value))
          return { state, selection: node.id };
        state = this.record(state, node.id, { scalar });
      }
      state = await this.mark(state, view, node.id, 0);
      return { state, selection: node.id };
    }
    if (operation.type === "replace") {
      nbtValueType(operation.value.type);
      if (node.parent !== null) {
        const parent = await this.node(view, node.parent);
        if (
          parent.type === NbtTag.List &&
          operation.value.type !== parent.elementType
        )
          throw new NbtError(
            0,
            "A list item's type must match its declaration",
          );
      }
      const count = await view.count(node.id),
        built = await this.build(
          { ...state, records: state.records.delete(node.id) },
          operation.value,
          node.parent,
          node.name,
          signal,
          budget,
          node.id,
        );
      state = await this.mark(built.state, view, node.id, built.count - count);
      state = { ...state, body: state.body.set(node.id, true) };
      return { state, selection: node.id };
    }
    if (operation.type === "array.splice") {
      if (!nbtArray(node.type))
        throw new NbtError(0, "Tag is not a numeric array");
      const array = view.arraySequence(resolved),
        insert = await this.arrayPart(node.type, operation.values, signal),
        next = array.splice(operation.index, operation.remove, insert);
      if (next.length > 2 ** 31 - 1)
        throw new NbtError(0, "Array exceeds its length field");
      state = this.record(state, node.id, { array: next });
      state = await this.mark(state, view, node.id, 0);
      return { state, selection: node.id };
    }
    if (node.type !== NbtTag.String || !node.data)
      throw new NbtError(0, "Tag is not a string");
    const bytes = nbtStringBytes(operation.text, this.baseline.encoding);
    try {
      const text = await this.data.splice(
          node.data,
          operation.offset,
          operation.remove,
          bytes,
          signal,
        ),
        max =
          this.baseline.encoding.endian === "little-varint"
            ? 2 ** 32 - 1
            : 65535;
      if (text.length > max)
        throw new NbtError(0, "String exceeds its length field");
      state = this.record(state, node.id, { text });
      state = await this.mark(state, view, node.id, 0);
      return { state, selection: node.id };
    } finally {
      bytes.fill(0);
    }
  }
  private viewOf(state: NbtEditState): NbtSerializableModel {
    return state === this.initial ? this.baseline : this.logical(state);
  }
  apply(
    operations: NbtEditOperation[],
    expectedRevision = this.revision,
    signal = new AbortController().signal,
    label = "Edit NBT",
  ) {
    return this.serial(async () => {
      await this.ready(signal);
      if (expectedRevision !== this.revision)
        throw new NbtError(0, "The document changed; reopen this edit");
      if (!operations.length || operations.length > 128)
        throw new NbtError(0, "Edit transactions require 1–128 operations");
      const encoded = new TextEncoder().encode(JSON.stringify(operations));
      if (encoded.length > 256 * 1024) {
        encoded.fill(0);
        throw new NbtError(
          0,
          "Edit transaction exceeds the bounded batch size",
        );
      }
      encoded.fill(0);
      if (label.length > 200)
        throw new NbtError(0, "Edit labels are limited to 200 characters");
      const allocationStart = this.sequence;
      const allocations = this.data.captureAllocations(),
        copies: string[] = [];
      this.createdCopies = copies;
      let committed = false;
      try {
        let next = this.state,
          selection = this.baseline.snapshot().root!,
          budget = { nodes: 0 };
        for (const operation of operations) {
          const result = await this.operation(next, operation, signal, budget);
          next = result.state;
          selection = result.selection;
        }
        this.check(signal);
        if (!Number.isSafeInteger(next.nodes) || next.nodes < 1)
          throw new NbtError(
            0,
            "Logical tag count exceeds the supported integer range",
          );
        if (next !== this.state) {
          await this.checkpoint({
            kind: "apply",
            allocationStart,
            allocationEnd: this.sequence,
            operations,
            label,
          });
          // The encrypted journal is the mutation's commit point. A late cancellation
          // must not leave in-memory state behind the journal that recovery will replay.
          this.undoStack.push({ state: this.state, label });
          this.redoStack = [];
          this.state = next;
          committed = true;
          this.revision++;
          this.emit();
        }
        return { selection, status: this.snapshot() };
      } catch (error) {
        if (!committed) {
          for (const prefix of copies) this.copies.delete(prefix);
          this.data.rollbackAllocations(allocations);
        }
        throw error;
      } finally {
        this.createdCopies = undefined;
      }
    });
  }
  undo(signal = new AbortController().signal) {
    return this.serial(async () => {
      this.check(signal);
      const previous = this.undoStack.at(-1);
      if (!previous) return this.snapshot();
      await this.checkpoint({ kind: "undo" });
      this.undoStack.pop();
      this.redoStack.push({ state: this.state, label: previous.label });
      this.state = previous.state;
      this.revision++;
      this.emit();
      return this.snapshot();
    });
  }
  redo(signal = new AbortController().signal) {
    return this.serial(async () => {
      this.check(signal);
      const next = this.redoStack.at(-1);
      if (!next) return this.snapshot();
      await this.checkpoint({ kind: "redo" });
      this.redoStack.pop();
      this.undoStack.push({ state: this.state, label: next.label });
      this.state = next.state;
      this.revision++;
      this.emit();
      return this.snapshot();
    });
  }
  beginSave(
    id: string,
    signal = new AbortController().signal,
    target?: NbtSaveTarget,
  ) {
    return this.serial(async () => {
      await this.ready(signal);
      if (
        target &&
        (typeof target.path !== "string" ||
          !target.path ||
          target.path.length > 8192 ||
          typeof target.copy !== "boolean")
      )
        throw new NbtError(0, "Invalid NBT save target");
      if (this.saving) {
        if (this.saving.id !== id)
          throw new NbtError(0, "A document save is already in progress");
        if (
          target &&
          (this.saving.target?.path !== target.path ||
            this.saving.target.copy !== target.copy)
        )
          throw new NbtError(
            0,
            "The pending NBT save belongs to another destination",
          );
        this.saving.suspended = false;
        this.emit();
        return this.saveSnapshot();
      }
      if (!id) throw new NbtError(0, "Save snapshot requires an identity");
      await this.checkpoint({
        kind: "save.begin",
        id,
        ...(target ? { target: { ...target } } : {}),
      });
      this.saving = {
        id,
        state: this.state,
        view: this.view(),
        revision: this.revision,
        version: this.version,
        ...(target ? { target: { ...target } } : {}),
      };
      this.emit();
      return this.saveSnapshot();
    });
  }
  prepareSave(id: string, metadata: { size: number; sha256: string }) {
    const captured = { ...metadata };
    return this.serial(async () => {
      if (this.saving?.id !== id)
        throw new NbtError(0, "Save snapshot is unavailable");
      if (
        !Number.isSafeInteger(captured.size) ||
        captured.size < 0 ||
        !/^[a-f0-9]{64}$/u.test(captured.sha256)
      )
        throw new NbtError(0, "Invalid NBT serialized save receipt");
      if (this.saving.metadata) {
        if (
          this.saving.metadata.size !== captured.size ||
          this.saving.metadata.sha256 !== captured.sha256
        )
          throw new NbtError(0, "The serialized NBT save changed");
        return this.saveSnapshot();
      }
      await this.checkpoint({ kind: "save.ready", id, metadata: captured });
      this.saving.metadata = captured;
      this.emit();
      return this.saveSnapshot();
    });
  }
  saveView(id: string) {
    if (this.saving?.id !== id)
      throw new NbtError(0, "Save snapshot is unavailable");
    return this.saving.view;
  }
  acknowledgeSave(id: string, version: string) {
    return this.serial(async () => {
      if (this.saving?.id !== id)
        throw new NbtError(0, "Save snapshot is unavailable");
      if (!version) throw new NbtError(0, "Save receipt has no version");
      await this.checkpoint({ kind: "save.ack", id, version });
      this.saved = this.saving.state;
      this.version = version;
      this.saving = undefined;
      this.uncertain = false;
      this.emit();
      return this.snapshot();
    });
  }
  failSave(id: string, uncertain: boolean, retain = false) {
    return this.serial(async () => {
      if (this.saving?.id === id) {
        await this.checkpoint({ kind: "save.fail", id, uncertain, retain });
        if (uncertain || retain) this.saving.suspended = true;
        else this.saving = undefined;
        this.uncertain = uncertain;
      }
      this.emit();
      return this.snapshot();
    });
  }
  async close() {
    if (this.closed) return;
    this.closed = true;
    await this.tail;
    this.undoStack = [];
    this.redoStack = [];
    this.copies.clear();
    this.saving = undefined;
    this.state = this.initial;
    this.saved = this.initial;
    await this.data.close();
  }
}

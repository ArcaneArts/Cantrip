/** Persistent maps and weighted sequences retain undo roots without copying whole containers. */
function hash(value: string) {
  let result = 2166136261;
  for (let i = 0; i < value.length; i++)
    result = Math.imul(result ^ value.charCodeAt(i), 16777619);
  return result >>> 0;
}
interface MapNode<T> {
  key: string;
  value: T;
  priority: number;
  left: MapNode<T> | null;
  right: MapNode<T> | null;
}
const before = <T>(a: MapNode<T>, b: MapNode<T>) =>
  a.priority < b.priority || (a.priority === b.priority && a.key < b.key);
function mergeMap<T>(
  a: MapNode<T> | null,
  b: MapNode<T> | null,
): MapNode<T> | null {
  if (!a) return b;
  if (!b) return a;
  return before(a, b)
    ? { ...a, right: mergeMap(a.right, b) }
    : { ...b, left: mergeMap(a, b.left) };
}
function setMap<T>(root: MapNode<T> | null, key: string, value: T): MapNode<T> {
  if (!root)
    return { key, value, priority: hash(key), left: null, right: null };
  if (key === root.key) return { ...root, value };
  if (key < root.key) {
    const left = setMap(root.left, key, value),
      node = { ...root, left };
    return before(left, node)
      ? { ...left, right: { ...node, left: left.right } }
      : node;
  }
  const right = setMap(root.right, key, value),
    node = { ...root, right };
  return before(right, node)
    ? { ...right, left: { ...node, right: right.left } }
    : node;
}
export class NbtPersistentMap<T> {
  constructor(private readonly root: MapNode<T> | null = null) {}
  get(key: string) {
    let node = this.root;
    while (node) {
      if (node.key === key) return node.value;
      node = key < node.key ? node.left : node.right;
    }
    return undefined;
  }
  has(key: string) {
    return this.get(key) !== undefined;
  }
  set(key: string, value: T) {
    return new NbtPersistentMap(setMap(this.root, key, value));
  }
  delete(key: string) {
    function remove(node: MapNode<T> | null): MapNode<T> | null {
      if (!node) return null;
      if (node.key === key) return mergeMap(node.left, node.right);
      return key < node.key
        ? { ...node, left: remove(node.left) }
        : { ...node, right: remove(node.right) };
    }
    return new NbtPersistentMap(remove(this.root));
  }
  *entries() {
    const stack: MapNode<T>[] = [];
    let node = this.root;
    while (node || stack.length) {
      while (node) {
        stack.push(node);
        node = node.left;
      }
      node = stack.pop()!;
      yield [node.key, node.value] as const;
      node = node.right;
    }
  }
}
export interface NbtPiece<T> {
  data: T;
  offset: number;
  count: number;
}
interface SequenceNode<T> {
  piece: NbtPiece<T>;
  priority: number;
  left: SequenceNode<T> | null;
  right: SequenceNode<T> | null;
  count: number;
}
let sequence = 0;
const size = <T>(node: SequenceNode<T> | null) => node?.count ?? 0;
function node<T>(
  piece: NbtPiece<T>,
  left: SequenceNode<T> | null = null,
  right: SequenceNode<T> | null = null,
  priority = hash(String(++sequence)),
): SequenceNode<T> {
  return {
    piece,
    left,
    right,
    priority,
    count: size(left) + piece.count + size(right),
  };
}
function merge<T>(
  a: SequenceNode<T> | null,
  b: SequenceNode<T> | null,
): SequenceNode<T> | null {
  if (!a) return b;
  if (!b) return a;
  return a.priority < b.priority
    ? node(a.piece, a.left, merge(a.right, b), a.priority)
    : node(b.piece, merge(a, b.left), b.right, b.priority);
}
function split<T>(
  root: SequenceNode<T> | null,
  at: number,
): [SequenceNode<T> | null, SequenceNode<T> | null] {
  if (!root) return [null, null];
  const left = size(root.left),
    end = left + root.piece.count;
  if (at < left) {
    const [a, b] = split(root.left, at);
    return [a, node(root.piece, b, root.right, root.priority)];
  }
  if (at > end) {
    const [a, b] = split(root.right, at - end);
    return [node(root.piece, root.left, a, root.priority), b];
  }
  if (at === left)
    return [root.left, node(root.piece, null, root.right, root.priority)];
  if (at === end)
    return [node(root.piece, root.left, null, root.priority), root.right];
  const cut = at - left;
  return [
    merge(root.left, node({ ...root.piece, count: cut })),
    merge(
      node({
        ...root.piece,
        offset: root.piece.offset + cut,
        count: root.piece.count - cut,
      }),
      root.right,
    ),
  ];
}
export class NbtSequence<T> {
  constructor(private readonly root: SequenceNode<T> | null = null) {}
  static from<T>(data: T, count: number, offset = 0) {
    if (!Number.isSafeInteger(count) || count < 0)
      throw new Error("Invalid NBT sequence length.");
    return new NbtSequence(count ? node({ data, offset, count }) : null);
  }
  get length() {
    return size(this.root);
  }
  splice(at: number, remove: number, insert = new NbtSequence<T>()) {
    if (
      !Number.isSafeInteger(at) ||
      at < 0 ||
      !Number.isSafeInteger(remove) ||
      remove < 0 ||
      at + remove > this.length
    )
      throw new Error("Invalid NBT sequence splice.");
    const [left, tail] = split(this.root, at),
      [, right] = split(tail, remove);
    return new NbtSequence(merge(merge(left, insert.root), right));
  }
  *slices(
    first = 0,
    limit = this.length - first,
  ): Generator<NbtPiece<T> & { position: number }> {
    if (first < 0 || limit < 0 || !Number.isSafeInteger(first + limit))
      throw new Error("Invalid NBT sequence page.");
    const end = Math.min(this.length, first + limit),
      stack: Array<{ node: SequenceNode<T>; start: number; visit: boolean }> =
        [];
    if (this.root) stack.push({ node: this.root, start: 0, visit: false });
    while (stack.length) {
      const frame = stack.pop()!,
        current = frame.node,
        at = frame.start + size(current.left),
        to = at + current.piece.count;
      if (frame.start >= end || frame.start + current.count <= first) continue;
      if (frame.visit) {
        const begin = Math.max(first, at),
          finish = Math.min(end, to);
        if (begin < finish)
          yield {
            data: current.piece.data,
            offset: current.piece.offset + begin - at,
            count: finish - begin,
            position: begin,
          };
        continue;
      }
      if (current.right)
        stack.push({ node: current.right, start: to, visit: false });
      stack.push({ ...frame, visit: true });
      if (current.left)
        stack.push({ node: current.left, start: frame.start, visit: false });
    }
  }
}

import { isDeepStrictEqual } from "node:util";

import type {
  WorkflowJsonValue,
  WorkflowPredicate,
} from "@cantrip/protocol/workflows";

export interface WorkflowValueSelection {
  found: boolean;
  value: WorkflowJsonValue | undefined;
}

function decodePointerToken(token: string): string {
  return token.replaceAll("~1", "/").replaceAll("~0", "~");
}

export function workflowValueAtPointer(
  root: WorkflowJsonValue,
  pointer: string,
): WorkflowValueSelection {
  if (pointer === "") return { found: true, value: root };
  let current: WorkflowJsonValue = root;
  for (const encodedToken of pointer.slice(1).split("/")) {
    const token = decodePointerToken(encodedToken);
    if (Array.isArray(current)) {
      if (!/^(?:0|[1-9][0-9]*)$/u.test(token)) {
        return { found: false, value: undefined };
      }
      const index = Number(token);
      if (index >= current.length) return { found: false, value: undefined };
      current = current[index]!;
      continue;
    }
    if (current === null || typeof current !== "object") {
      return { found: false, value: undefined };
    }
    if (!Object.hasOwn(current, token)) {
      return { found: false, value: undefined };
    }
    current = current[token]!;
  }
  return { found: true, value: current };
}

function orderedComparison(
  left: WorkflowJsonValue,
  right: WorkflowJsonValue,
): number | null {
  if (typeof left === "number" && typeof right === "number") {
    return left === right ? 0 : left < right ? -1 : 1;
  }
  if (typeof left === "string" && typeof right === "string") {
    return left === right ? 0 : left < right ? -1 : 1;
  }
  return null;
}

function containsValue(
  container: WorkflowJsonValue,
  expected: WorkflowJsonValue,
): boolean {
  if (typeof container === "string" && typeof expected === "string") {
    return container.includes(expected);
  }
  if (Array.isArray(container)) {
    return container.some((value) => isDeepStrictEqual(value, expected));
  }
  if (
    container !== null &&
    typeof container === "object" &&
    !Array.isArray(container) &&
    typeof expected === "string"
  ) {
    return Object.hasOwn(container, expected);
  }
  return false;
}

export function evaluateWorkflowPredicate(
  root: WorkflowJsonValue,
  predicate: WorkflowPredicate,
): boolean {
  const selected = workflowValueAtPointer(root, predicate.path);
  if (predicate.operator === "exists") return selected.found;
  if (predicate.operator === "not-exists") return !selected.found;
  if (!selected.found || predicate.value === undefined) return false;
  if (predicate.operator === "equals") {
    return isDeepStrictEqual(selected.value, predicate.value);
  }
  if (predicate.operator === "not-equals") {
    return !isDeepStrictEqual(selected.value, predicate.value);
  }
  if (predicate.operator === "contains") {
    return containsValue(selected.value!, predicate.value);
  }
  const comparison = orderedComparison(selected.value!, predicate.value);
  if (comparison === null) return false;
  if (predicate.operator === "greater-than") return comparison > 0;
  if (predicate.operator === "greater-than-or-equals") return comparison >= 0;
  if (predicate.operator === "less-than") return comparison < 0;
  return comparison <= 0;
}

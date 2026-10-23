import type { SyntaxFrame, TokenKind } from "./types";

export function batchVariable(text: string): string | undefined {
  return /^(?:%(?:%~[fdpnxsatz]*(?:\$\w+:)?[a-z]|~[fdpnxsatz]*(?:\$\w+:)?[0-9a-z]|%[a-z]|[0-9*]|[^%\r\n]+%)|![^!\r\n]+!)/iu.exec(
    text,
  )?.[0];
}

export function batchTokenAt(
  text: string,
  index: number,
): { length: number; kind: TokenKind } | null {
  const rest = text.slice(index);
  // Caret escaping precedes variable/comment recognition in command text.
  if (rest.startsWith("^"))
    return { length: Math.min(2, rest.length), kind: "text" };
  const variable = batchVariable(rest);
  if (variable) return { length: variable.length, kind: "variable" };
  const before = text.slice(0, index);
  if (/^(?:\s*@?\s*)$/u.test(before) || /[(&|]\s*@?\s*$/u.test(before)) {
    if (/^(?:rem(?:\s|$)|::)/iu.test(rest))
      return { length: rest.length, kind: "comment" };
    const label = /^:[^:\s]\S*/u.exec(rest)?.[0];
    if (label) return { length: label.length, kind: "function" };
  }
  return null;
}

export function groovyStringAt(
  text: string,
  index: number,
): SyntaxFrame | null {
  if (text.startsWith("$/", index))
    return {
      kind: "string",
      language: "groovy",
      start: "groovy-dollar",
      end: "/$",
      multiline: true,
      interpolate: true,
    };
  // Slashy strings begin an expression. A division after a value stays an operator.
  if (
    text[index] === "/" &&
    /(?:^|[=(:,\[!&|?{};]|\breturn)\s*$/u.test(text.slice(0, index))
  )
    return {
      kind: "string",
      language: "groovy",
      end: "/",
      multiline: true,
      interpolate: true,
    };
  return null;
}

import { languageForFence, plainDefinition } from "./languages";
import type {
  LanguageCatalog,
  LanguageId,
  SyntaxFrame,
  SyntaxLine,
  SyntaxState,
  SyntaxToken,
  TokenKind,
} from "./types";

export function initialSyntaxState(language: LanguageId): SyntaxState {
  return {
    frames: [
      {
        kind:
          language === "markdown"
            ? "markdown"
            : language === "html" || language === "xml"
              ? "markup"
              : "code",
        language,
      },
    ],
  };
}

export function syntaxStateKey(state: SyntaxState): string {
  return JSON.stringify(state);
}

/** A lexical scanner, deliberately independent of DOM, React, and project symbols. */
export function tokenizeLine(
  text: string,
  previous: SyntaxState,
  catalog: LanguageCatalog,
): SyntaxLine {
  const frames = previous.frames.map((frame) => ({ ...frame }));
  const tokens: SyntaxToken[] = [];
  let index = 0;
  const emit = (to: number, kind: TokenKind) => {
    if (to <= index) return;
    // A pathological line may contain millions of alternating tokens. Preserve
    // its text and lexical state while bounding the paint layer's node count.
    if (tokens.length >= 2048) kind = "text";
    const last = tokens.at(-1);
    if (last?.kind === kind && last.to === index) last.to = to;
    else tokens.push({ from: index, to, kind });
    index = to;
  };
  const pushCode = (language: LanguageId, end?: string) =>
    frames.push({
      kind: "code",
      language,
      ...(end ? { end, depth: end === "}" ? 1 : undefined } : {}),
    });
  // Fenced code returns to Markdown only at a matching, whole closing fence.
  const fenced = [...frames].reverse().find((frame) => frame.fence);
  if (
    fenced?.fence &&
    new RegExp(
      `^\\s{0,3}${fenced.fence[0]}{${fenced.fence.length},}\\s*$`,
      "u",
    ).test(text)
  ) {
    frames.splice(frames.indexOf(fenced));
    emit(text.length, "punctuation");
    return { tokens, state: { frames } };
  }
  // A heredoc terminator must occupy the line (tab stripping is explicit).
  const top = frames.at(-1);
  if (
    top?.kind === "string" &&
    top.start === "heredoc" &&
    text.replace(/^\t+/u, "") === top.end
  ) {
    emit(text.length, "string");
    frames.pop();
    return { tokens, state: { frames } };
  }
  while (index < text.length) {
    const frame = frames.at(-1)!;
    const definition = catalog[frame.language] ?? plainDefinition;
    const rest = text.slice(index);
    if (frame.kind === "yaml-block") {
      const indent = /^\s*/u.exec(text)![0].length;
      if (text.trim() === "" || indent > (frame.depth ?? 0)) {
        emit(text.length, "string");
        continue;
      }
      frames.pop();
      continue;
    }
    if (frame.kind === "comment") {
      if (
        definition.nestedComments &&
        frame.start &&
        rest.startsWith(frame.start)
      ) {
        frame.depth = (frame.depth ?? 1) + 1;
        emit(index + frame.start.length, "comment");
      } else if (frame.end && rest.startsWith(frame.end)) {
        emit(index + frame.end.length, "comment");
        if ((frame.depth ?? 1) <= 1) frames.pop();
        else frame.depth!--;
      } else emit(index + 1, "comment");
      continue;
    }
    if (frame.kind === "string") {
      if (frame.start === "heredoc") {
        emit(text.length, "string");
        continue;
      }
      if (frame.escaped) {
        frame.escaped = false;
        emit(index + 1, "string");
      } else if (rest.startsWith("\\") && !frame.start?.startsWith("raw")) {
        frame.escaped = true;
        emit(index + 1, "string");
      } else if (frame.end && rest.startsWith(frame.end)) {
        const end = frame.end;
        emit(index + end.length, "string");
        // SQL escapes quotes by doubling them.
        if (frame.language === "sql" && text.slice(index).startsWith(end))
          emit(index + end.length, "string");
        else frames.pop();
      } else if (
        frame.interpolate &&
        (rest.startsWith("${") ||
          (frame.language === "ruby" && rest.startsWith("#{")))
      ) {
        emit(index + 2, "punctuation");
        pushCode(frame.language, "}");
      } else emit(index + 1, "string");
      continue;
    }
    if (frame.kind === "markdown") {
      const fence =
        index === 0 ? /^ {0,3}(`{3,}|~{3,})\s*([\w#+.-]*)/u.exec(text) : null;
      if (fence) {
        emit(text.length, "punctuation");
        frames.push({
          kind: "code",
          language: languageForFence(fence[2] ?? ""),
          fence: fence[1],
        });
      } else if (
        index === 0 &&
        /^\s{0,3}(?:#{1,6}\s|(?:[-*_]\s*){3,}$|(?:=+|-+)\s*$)/u.test(text)
      )
        emit(text.length, "heading");
      else if (rest.startsWith("<!--")) {
        emit(index + 4, "comment");
        frames.push({ kind: "comment", language: "html", end: "-->" });
      } else if (rest.startsWith("`")) {
        const delimiter = /^`+/u.exec(rest)![0];
        emit(index + delimiter.length, "string");
        frames.push({
          kind: "string",
          language: "markdown",
          end: delimiter,
          multiline: false,
        });
      } else {
        const marker =
          /^(?:\*{1,2}|_{1,2}|~~|!?(?=\[)|\[[^\]]*\]\([^)]*\)|https?:\/\/\S+)/u.exec(
            rest,
          )?.[0];
        if (marker)
          emit(
            index + marker.length,
            marker.startsWith("http") || marker.includes("](")
              ? "string"
              : "punctuation",
          );
        else emit(index + 1, "text");
      }
      continue;
    }
    if (frame.kind === "markup") {
      if (rest.startsWith("<!--")) {
        emit(index + 4, "comment");
        frames.push({ kind: "comment", language: frame.language, end: "-->" });
      } else if (rest.startsWith("<![CDATA[")) {
        emit(index + 9, "string");
        frames.push({
          kind: "string",
          language: frame.language,
          end: "]]>",
          start: "raw",
          multiline: true,
        });
      } else if (
        /^<\/?(?:[\w:-]+|>)/u.test(rest) ||
        rest.startsWith("<!") ||
        rest.startsWith("<?")
      ) {
        const name = /^<\/?([\w:-]*)/u.exec(rest);
        frames.push({
          kind: "tag",
          language: frame.language,
          closing: rest.startsWith("</"),
          tagName: name?.[1]?.toLowerCase(),
        });
        emit(index + (rest.startsWith("</") ? 2 : 1), "punctuation");
        if (name?.[1]) emit(index + name[1].length, "tag");
      } else if (
        (frame.language === "jsx" || frame.language === "tsx") &&
        rest.startsWith("{")
      ) {
        emit(index + 1, "punctuation");
        pushCode(frame.language, "}");
      } else {
        const entity = /^&(?:#\d+|#x[\da-fA-F]+|\w+);/u.exec(rest)?.[0];
        emit(index + (entity?.length ?? 1), entity ? "literal" : "text");
      }
      continue;
    }
    if (frame.kind === "tag") {
      if (
        rest.startsWith("/>") ||
        rest.startsWith("?>") ||
        rest.startsWith(">")
      ) {
        const selfClosing =
          rest.startsWith("/>") ||
          rest.startsWith("?>") ||
          [
            "area",
            "base",
            "br",
            "col",
            "embed",
            "hr",
            "img",
            "input",
            "link",
            "meta",
            "param",
            "source",
            "track",
            "wbr",
          ].includes(frame.tagName ?? "");
        emit(index + (rest.startsWith(">") ? 1 : 2), "punctuation");
        frames.pop();
        const markup = frames.at(-1)!;
        if (markup.depth !== undefined) {
          if (frame.closing) markup.depth--;
          else if (!selfClosing) markup.depth++;
          if (markup.depth === 0) frames.pop();
        }
        if (
          !frame.closing &&
          !selfClosing &&
          ["script", "style"].includes(frame.tagName ?? "") &&
          frame.language === "html"
        )
          pushCode(
            frame.tagName === "script" ? "javascript" : "css",
            `</${frame.tagName}`,
          );
      } else if (/^["']/u.test(rest)) {
        const quote = rest[0]!;
        emit(index + 1, "string");
        frames.push({
          kind: "string",
          language: frame.language,
          end: quote,
          multiline: true,
        });
      } else if (
        (frame.language === "jsx" || frame.language === "tsx") &&
        rest.startsWith("{")
      ) {
        emit(index + 1, "punctuation");
        pushCode(frame.language, "}");
      } else {
        const attribute = /^[\w:@.-]+/u.exec(rest)?.[0];
        emit(
          index + (attribute?.length ?? 1),
          attribute ? "attribute" : rest.startsWith("=") ? "operator" : "text",
        );
      }
      continue;
    }
    // Code frame, possibly nested inside a template, JSX expression, or HTML.
    if (
      frame.end?.startsWith("</") &&
      rest.toLowerCase().startsWith(frame.end)
    ) {
      frames.pop();
      continue;
    }
    if (frame.end === "}") {
      if (rest.startsWith("{")) frame.depth = (frame.depth ?? 1) + 1;
      if (rest.startsWith("}") && --frame.depth! === 0) {
        emit(index + 1, "punctuation");
        frames.pop();
        continue;
      }
    }
    if (frame.language === "plain") {
      emit(text.length, "text");
      continue;
    }
    if (
      frame.language === "yaml" &&
      /^[|>][+-]?[1-9]?\s*(?:#.*)?$/u.test(rest) &&
      /:\s*$/u.test(text.slice(0, index))
    ) {
      emit(text.length, "punctuation");
      frames.push({
        kind: "yaml-block",
        language: "yaml",
        depth: /^\s*/u.exec(text)![0].length,
      });
      continue;
    }
    if (/^\s/u.test(rest)) {
      emit(index + (/^\s+/u.exec(rest)?.[0].length ?? 1), "text");
      continue;
    }
    const block = definition.blockComments?.find(([start]) =>
      rest.startsWith(start),
    );
    if (block) {
      emit(index + block[0].length, "comment");
      frames.push({
        kind: "comment",
        language: frame.language,
        start: block[0],
        end: block[1],
        depth: 1,
      });
      continue;
    }
    if (definition.lineComments?.some((start) => rest.startsWith(start))) {
      emit(text.length, "comment");
      continue;
    }
    const raw =
      frame.language === "rust" ? /^(?:br|r)(#{0,32})"/u.exec(rest) : null;
    if (raw) {
      emit(index + raw[0].length, "string");
      frames.push({
        kind: "string",
        language: frame.language,
        end: `"${raw[1]}`,
        start: "raw",
        multiline: true,
      });
      continue;
    }
    if (
      (frame.language === "shell" ||
        frame.language === "php" ||
        frame.language === "ruby") &&
      rest.startsWith("<<")
    ) {
      const here = /^<<[-~]?\s*['"]?(\w+)['"]?/u.exec(rest);
      if (here) {
        emit(index + here[0].length, "string");
        frames.push({
          kind: "string",
          language: frame.language,
          end: here[1],
          start: "heredoc",
          multiline: true,
        });
        if (index < text.length) emit(text.length, "text");
        continue;
      }
    }
    if (frame.language === "sql") {
      const dollar = /^\$(?:[a-zA-Z_]\w*)?\$/u.exec(rest)?.[0];
      if (dollar) {
        emit(index + dollar.length, "string");
        frames.push({
          kind: "string",
          language: "sql",
          end: dollar,
          start: "raw",
          multiline: true,
        });
        continue;
      }
    }
    const multiline = definition.multilineQuotes?.find((quote) =>
      rest.startsWith(quote),
    );
    const quote =
      multiline ??
      definition.quotes?.find((candidate) => rest.startsWith(candidate)) ??
      (definition.template && rest.startsWith("`") ? "`" : undefined);
    if (
      quote &&
      !(
        frame.language === "rust" &&
        quote === "'" &&
        /^'[a-zA-Z_]\w*(?!')\b/u.test(rest) &&
        !/^'(?:[^'\\]|\\.)'/u.test(rest)
      )
    ) {
      const end = quote.startsWith("[") ? quote.replaceAll("[", "]") : quote;
      emit(index + quote.length, "string");
      frames.push({
        kind: "string",
        language: frame.language,
        end,
        multiline: Boolean(multiline) || quote === "`",
        interpolate: definition.template && quote !== "'",
      });
      continue;
    }
    if (definition.jsx && /^<(?:[A-Za-z][\w.:-]*|>|\/)/u.test(rest)) {
      frames.push({ kind: "markup", language: frame.language, depth: 0 });
      continue;
    }
    const variable = definition.hashVariables
      ? /^\$(?:\{[^}]*\}|\([^)]*\)|[\w@*?!#$-]+)/u.exec(rest)?.[0]
      : null;
    if (variable) {
      emit(index + variable.length, "variable");
      continue;
    }
    if (frame.language === "c" || frame.language === "cpp") {
      const directive = /^#\s*[a-zA-Z]+/u.exec(rest)?.[0];
      if (directive) {
        emit(index + directive.length, "keyword");
        continue;
      }
    }
    const numeric =
      /^(?:0[xX][\da-fA-F_]+|0[bB][01_]+|0[oO][0-7_]+|(?:\d[\d_]*(?:\.[\d_]*)?|\.\d[\d_]*)(?:[eE][+-]?\d[\d_]*)?)(?:[uif](?:8|16|32|64|128|size)|[fFdDmMnNuUlL]*)?/u.exec(
        rest,
      )?.[0];
    if (numeric) {
      emit(index + numeric.length, "number");
      continue;
    }
    const identifier = (
      frame.language === "css" || frame.language === "scss"
        ? /^[\p{L}_$-][\p{L}\p{N}_$-]*/u
        : /^[\p{L}_$][\p{L}\p{N}_$]*/u
    ).exec(rest)?.[0];
    if (identifier) {
      const normalized = definition.caseInsensitive
        ? identifier.toLowerCase()
        : identifier;
      const after = text.slice(index + identifier.length);
      const before = text.slice(Math.max(0, index - 128), index);
      const isProperty =
        [
          "json",
          "jsonc",
          "yaml",
          "toml",
          "env",
          "ini",
          "properties",
          "css",
          "scss",
        ].includes(frame.language) && /^\s*[:=]/u.test(after);
      const kind: TokenKind = definition.keywords.has(normalized)
        ? "keyword"
        : definition.literals?.has(normalized)
          ? "literal"
          : isProperty
            ? "attribute"
            : definition.types?.has(normalized) ||
                /^[A-Z][\w$]*$/u.test(identifier)
              ? "type"
              : /^\s*\(/u.test(after)
                ? "function"
                : [
                      "json",
                      "jsonc",
                      "yaml",
                      "toml",
                      "env",
                      "ini",
                      "properties",
                      "css",
                      "scss",
                    ].includes(frame.language) && /^\s*[:=]/u.test(after)
                  ? "attribute"
                  : /\b(?:class|struct|interface|trait|enum|type|protocol|extends|impl)\s+$/u.test(
                        before,
                      )
                    ? "type"
                    : "text";
      emit(index + identifier.length, kind);
      continue;
    }
    emit(
      index + 1,
      /^[{}()[\],;:.]/u.test(rest)
        ? "punctuation"
        : /^[+\-*/%=<>!&|^~?:@#\\]/u.test(rest)
          ? "operator"
          : "text",
    );
  }
  // Ordinary quoted strings terminate at a physical newline; multiline forms
  // and a backslash continuation retain their state for the next line.
  const last = frames.at(-1);
  if (last?.kind === "string") {
    if (!last.multiline && !last.escaped) frames.pop();
    else last.escaped = false;
  }
  return { tokens, state: { frames } };
}

import { describe, expect, it } from "vitest";
import { SyntaxDocument, textChange } from "./document";
import { languageForFile, loadLanguage } from "./languages";
import { initialSyntaxState, tokenizeLine } from "./tokenizer";
import type { LanguageId, TokenKind } from "./types";

async function scan(language: LanguageId, text: string) {
  const catalog = await loadLanguage(language);
  const document = new SyntaxDocument(text, language, catalog);
  return document.highlight(0, document.lines.length).map((line) => ({
    ...line,
    colored: line.tokens
      .filter((token) => token.kind !== "text")
      .map((token) => [line.text.slice(token.from, token.to), token.kind]),
  }));
}
const samples: [LanguageId, string, string, TokenKind][] = [
  ["javascript", "const answer = 42; // note", "const", "keyword"],
  ["typescript", "interface Person { name: string }", "interface", "keyword"],
  ["jsx", 'const node = <Card title="ok">{value}</Card>', "Card", "tag"],
  ["tsx", "const node: View = <Card />", "Card", "tag"],
  ["rust", "pub fn main() { let answer = 42; }", "fn", "keyword"],
  ["dart", "class Person extends Object {}", "class", "keyword"],
  ["python", "def greet(name): # note", "def", "keyword"],
  ["go", "func main() { defer done() }", "func", "keyword"],
  ["java", "public record Person(String name) {}", "record", "keyword"],
  ["groovy", "def version = '1.0'", "def", "keyword"],
  ["kotlin", 'suspend fun greet() = "hello"', "suspend", "keyword"],
  ["swift", "guard let value = item else { return }", "guard", "keyword"],
  ["c", "#include <stdio.h>", "#include", "keyword"],
  ["cpp", "constexpr int value = 1;", "constexpr", "keyword"],
  ["csharp", "namespace Example { record Person {} }", "namespace", "keyword"],
  ["ruby", "def greet(name) # note", "def", "keyword"],
  ["php", "echo $message;", "$message", "variable"],
  ["lua", "local answer = 42 -- note", "local", "keyword"],
  ["html", '<div class="card">Hello</div>', "div", "tag"],
  ["xml", '<item name="value" />', "item", "tag"],
  ["css", "color: inherit;", "inherit", "keyword"],
  ["scss", "@include button;", "include", "keyword"],
  ["json", '{"ok": true}', "true", "literal"],
  ["jsonc", "// config", "// config", "comment"],
  ["yaml", "enabled: true # config", "true", "literal"],
  ["toml", 'name = "Cantrip"', "name", "attribute"],
  ["markdown", "# Heading", "# Heading", "heading"],
  ["shell", "export NAME=$USER", "export", "keyword"],
  ["batch", "@ECHO OFF", "ECHO", "keyword"],
  ["sql", "SELECT name FROM people;", "SELECT", "keyword"],
  ["dockerfile", "FROM node:24", "FROM", "keyword"],
  ["makefile", "include shared.mk", "include", "keyword"],
  ["env", "NAME=cantrip", "NAME", "attribute"],
  ["ini", "; comment", "; comment", "comment"],
  ["properties", "name=value", "name", "attribute"],
];

describe("owned syntax catalog", () => {
  it.each(samples)("highlights %s", async (language, text, expected, kind) => {
    const lines = await scan(language, text);
    expect(lines[0]!.colored).toContainEqual([expected, kind]);
    expect(
      lines[0]!.tokens
        .map((token) => text.slice(token.from, token.to))
        .join(""),
    ).toBe(text);
  });
  it.each([
    ["source.tsx", "", "tsx"],
    ["Dockerfile.dev", "", "dockerfile"],
    ["Makefile", "", "makefile"],
    [".env.local", "", "env"],
    ["C:\\project\\main.rs", "", "rust"],
    ["Cargo.toml", "", "toml"],
    ["Cargo.lock", "", "toml"],
    ["/project/nested/Cargo.lock", "", "toml"],
    ["C:\\project\\Cargo.lock", "", "toml"],
    ["CARGO.LOCK", "", "toml"],
    ["Cargo.lock.bak", "", "plain"],
    ["Cargo.lock/main.rs", "", "rust"],
    ["package.lock", "", "plain"],
    ["yarn.lock", "", "plain"],
    ["pnpm-lock.yaml", "", "yaml"],
    ["script", "#!/usr/bin/env python3\n", "python"],
    ["script", "#!/bin/bash\n", "shell"],
    ["unknown.thing", "const x = 1", "plain"],
    ["build.gradle", "", "groovy"],
    ["settings.gradle", "", "groovy"],
    ["build.gradle.kts", "", "kotlin"],
    ["gradlew.BAT", "", "batch"],
    ["scripts/build.cmd", "", "batch"],
  ])("resolves %s", (path, prefix, language) =>
    expect(languageForFile(path, prefix)).toBe(language),
  );

  it("handles nested Rust comments and raw strings without interpreting their contents", async () => {
    const lines = await scan(
      "rust",
      '/* outer\n/* nested */ still\n*/ let value = r##"a " // raw\nend"##;',
    );
    expect(lines[1]!.colored).toEqual([["/* nested */ still", "comment"]]);
    expect(lines[2]!.colored).toContainEqual(["let", "keyword"]);
    expect(lines[3]!.colored).toContainEqual(['end"##', "string"]);
  });
  it("distinguishes Rust lifetimes from character literals", async () => {
    const lines = await scan(
      "rust",
      "fn use_ref<'a>(v: &'a str) { let c = 'x'; }",
    );
    expect(lines[0]!.colored.filter(([, kind]) => kind === "string")).toEqual([
      ["'x'", "string"],
    ]);
  });
  it("resumes code after nested template expressions", async () => {
    const lines = await scan(
      "javascript",
      "const text = `hello ${format({ value: `${name}` })}\nworld`; let n = 1",
    );
    expect(lines[0]!.colored).toContainEqual(["format", "function"]);
    expect(lines[1]!.colored).toContainEqual(["let", "keyword"]);
    expect(lines[1]!.colored).toContainEqual(["world`", "string"]);
  });
  it("supports HTML embedded code and returns to tag parsing", async () => {
    const lines = await scan(
      "html",
      '<script>const x = "<div>";\n</script><style>body { color: inherit }</style>',
    );
    expect(lines[0]!.colored).toContainEqual(["const", "keyword"]);
    expect(lines[0]!.colored).toContainEqual(['"<div>"', "string"]);
    expect(lines[1]!.colored).toContainEqual(["script", "tag"]);
    expect(lines[1]!.colored).toContainEqual(["inherit", "keyword"]);
  });
  it("supports nested JSX tags, attributes, expressions and the following code", async () => {
    const lines = await scan(
      "tsx",
      "const n = <><Card title={format({x: 1})}><span>{name}</span></Card></>; const other = 2;",
    );
    expect(lines[0]!.colored.filter(([text]) => text === "const")).toHaveLength(
      2,
    );
    expect(lines[0]!.colored).toContainEqual(["format", "function"]);
    expect(lines[0]!.colored).toContainEqual(["title", "attribute"]);
  });
  it("highlights fenced languages and only closes a matching fence", async () => {
    const lines = await scan(
      "markdown",
      '```python\ndef greet():\n~~~\n    return "ok"\n```\n# Back',
    );
    expect(lines[1]!.colored).toContainEqual(["def", "keyword"]);
    expect(lines[3]!.colored).toContainEqual(["return", "keyword"]);
    expect(lines[5]!.colored).toEqual([["# Back", "heading"]]);
  });
  it.each(["python", "toml"] as const)(
    "carries %s multiline strings",
    async (language) => {
      const lines = await scan(
        language,
        'value = """first\n# still a string\nlast"""',
      );
      expect(lines[1]!.colored).toEqual([["# still a string", "string"]]);
    },
  );
  it("handles Lua long strings and SQL dollar strings", async () => {
    expect(
      (await scan("lua", "local s = [=[first\n-- still a string\n]=]"))[1]!
        .colored,
    ).toEqual([["-- still a string", "string"]]);
    expect(
      (await scan("sql", "SELECT $body$first\n-- still a string\n$body$;"))[1]!
        .colored,
    ).toEqual([["-- still a string", "string"]]);
  });
  it("handles shell heredocs with an exact terminator", async () => {
    const lines = await scan("shell", "cat <<'END'\n# text\nEND\necho done");
    expect(lines[1]!.colored).toEqual([["# text", "string"]]);
    expect(lines[3]!.colored).toContainEqual(["echo", "keyword"]);
  });
  it("does not carry an incomplete ordinary string into unrelated code", async () => {
    const lines = await scan(
      "javascript",
      'const s = "unfinished\nlet value = 1',
    );
    expect(lines[1]!.colored).toContainEqual(["let", "keyword"]);
  });
  it("always covers escaped delimiters, Unicode, and incomplete input", async () => {
    const catalog = await loadLanguage("typescript");
    for (const text of [
      '"a\\\"b"',
      "const café = '😀é'",
      "/*",
      "`${",
      "<",
      "",
      "a-b",
      "\\",
    ]) {
      const line = tokenizeLine(
        text,
        initialSyntaxState("typescript"),
        catalog,
      );
      expect(
        line.tokens.map((token) => text.slice(token.from, token.to)).join(""),
      ).toBe(text);
      expect(line.tokens.every((token) => token.to > token.from)).toBe(true);
    }
  });
});

describe("incremental syntax document", () => {
  it("handles Gradle closures, interpolated and multiline Groovy strings, slashy strings and division", async () => {
    const lines = await scan(
      "groovy",
      [
        "repositories { mavenCentral() }",
        'def version = "value ${project.version}"',
        "def literal = '''first",
        "${stillLiteral}",
        "last'''",
        "def regex = /a\\/b/",
        "def path = $/first $$ dollar",
        "C:\\workspace /$; def count = 6 / 2",
      ].join("\n"),
    );
    expect(lines[0]!.colored).toContainEqual(["repositories", "function"]);
    expect(lines[1]!.colored).toContainEqual(["${", "punctuation"]);
    expect(lines[3]!.colored).toEqual([["${stillLiteral}", "string"]]);
    expect(lines[5]!.colored).toContainEqual(["/a\\/b/", "string"]);
    expect(lines[7]!.colored).toContainEqual(["C:\\workspace /$", "string"]);
    expect(lines[7]!.colored).toContainEqual(["/", "operator"]);
    expect(lines[7]!.colored).toContainEqual(["def", "keyword"]);
  });
  it("handles batch comments, labels, parameters and variables inside Windows paths", async () => {
    const lines = await scan(
      "batch",
      [
        "@REM Gradle launcher",
        ":: alternative comment",
        ":run",
        'set "JAVA_EXE=%JAVA_HOME%\\bin\\java.exe"',
        'echo "%~dp0" !JAVA_EXE! %%~fG %1 %*',
        "echo rem is text ^%escaped^%",
        'echo "C:\\directory\\" & ECHO done',
      ].join("\n"),
    );
    expect(lines[0]!.colored).toContainEqual([
      "REM Gradle launcher",
      "comment",
    ]);
    expect(lines[1]!.colored).toEqual([[":: alternative comment", "comment"]]);
    expect(lines[2]!.colored).toEqual([[":run", "function"]]);
    expect(lines[3]!.colored).toContainEqual(["%JAVA_HOME%", "variable"]);
    for (const value of ["%~dp0", "!JAVA_EXE!", "%%~fG", "%1", "%*"])
      expect(lines[4]!.colored).toContainEqual([value, "variable"]);
    expect(
      lines[5]!.colored.some(
        ([, kind]) => kind === "comment" || kind === "variable",
      ),
    ).toBe(false);
    expect(lines[6]!.colored).toContainEqual(["ECHO", "keyword"]);
  });
  it.each(["groovy", "batch"] as const)(
    "keeps incremental %s scans consistent through multiline edits",
    async (language) => {
      const catalog = await loadLanguage(language);
      let text =
        language === "groovy"
          ? "def text = '''one\ntwo\nthree'''\ndef value = 1"
          : '@echo off\nset "ROOT=%~dp0"\nrem launcher\necho !ROOT!';
      const document = new SyntaxDocument(text, language, catalog);
      document.highlight(0, document.lines.length);
      for (const next of [
        text.replace("two", "''' two"),
        "\n" + text,
        text.slice(0, 8),
        text,
      ]) {
        document.apply(textChange(text, next));
        text = next;
        expect(document.highlight(0, document.lines.length)).toEqual(
          new SyntaxDocument(text, language, catalog).highlight(
            0,
            document.lines.length,
          ),
        );
      }
    },
  );
  it("keeps YAML block scalars as strings until indentation returns", async () => {
    const lines = await scan(
      "yaml",
      "message: |\n  # text, not a comment\n  still text\nnext: true",
    );
    expect(lines[1]!.colored).toEqual([["  # text, not a comment", "string"]]);
    expect(lines[3]!.colored).toContainEqual(["true", "literal"]);
  });
  it("bounds tokens on pathological lines while retaining text and lexical state", async () => {
    const line = "a+1;".repeat(10000) + "/*";
    const scanned = await scan("javascript", line + "\ncomment");
    expect(scanned[0]!.tokens.length).toBeLessThanOrEqual(2049);
    expect(
      scanned[0]!.tokens
        .map((token) => line.slice(token.from, token.to))
        .join(""),
    ).toBe(line);
    expect(scanned[1]!.colored).toEqual([["comment", "comment"]]);
  });
  it("stops scanning an unchanged suffix after lexical state converges", async () => {
    const catalog = await loadLanguage("javascript");
    const original = Array.from(
      { length: 1000 },
      (_, i) => `const value${i} = ${i};`,
    ).join("\n");
    const document = new SyntaxDocument(original, "javascript", catalog);
    document.highlight(0, 1000);
    const before = document.scannedLines;
    const next = original.replace("value10 = 10", "value10 = 20");
    document.apply(textChange(original, next));
    document.highlight(0, 1000);
    expect(document.scannedLines - before).toBeLessThanOrEqual(2);
  });
  it("propagates a new multiline comment through the affected suffix", async () => {
    const catalog = await loadLanguage("javascript");
    const document = new SyntaxDocument(
      "let a = 1;\nlet b = 2;\n*/ let c = 3;\nlet d = 4;",
      "javascript",
      catalog,
    );
    document.highlight(0, 4);
    document.apply({ from: 0, to: 0, insert: "/*" });
    const lines = document.highlight(0, 4);
    expect(lines[1]!.tokens).toEqual([{ from: 0, to: 10, kind: "comment" }]);
    expect(lines[3]!.tokens[0]!.kind).toBe("keyword");
  });
  it("matches a fresh scan through insertions, deletions, and rapid unhighlighted changes", async () => {
    const catalog = await loadLanguage("javascript");
    let text = "const a = 1;\n/* comment */\nconst b = `hello`;\n";
    const document = new SyntaxDocument(text, "javascript", catalog);
    document.highlight(0, 4);
    for (const next of [
      "// first\n" + text,
      "/*\n" + text + "\n*/",
      "const a = `x\n${1}`;\n",
      "",
      "\n\n",
      "const 😀 = 1;",
    ]) {
      document.apply(textChange(text, next));
      text = next;
    }
    const fresh = new SyntaxDocument(text, "javascript", catalog);
    expect(document.highlight(0, 100)).toEqual(fresh.highlight(0, 100));
  });
});

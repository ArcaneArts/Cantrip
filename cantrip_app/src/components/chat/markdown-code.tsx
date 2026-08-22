import {
  Highlight,
  type Language,
  type PrismTheme,
} from "prism-react-renderer";
import Prism from "prismjs";
import "prismjs/components/prism-bash.js";
import "prismjs/components/prism-c.js";
import "prismjs/components/prism-cpp.js";
import "prismjs/components/prism-csharp.js";
import "prismjs/components/prism-dart.js";
import "prismjs/components/prism-diff.js";
import "prismjs/components/prism-go.js";
import "prismjs/components/prism-graphql.js";
import "prismjs/components/prism-java.js";
import "prismjs/components/prism-json.js";
import "prismjs/components/prism-jsx.js";
import "prismjs/components/prism-kotlin.js";
import "prismjs/components/prism-lua.js";
import "prismjs/components/prism-markdown.js";
import "prismjs/components/prism-python.js";
import "prismjs/components/prism-ruby.js";
import "prismjs/components/prism-rust.js";
import "prismjs/components/prism-scss.js";
import "prismjs/components/prism-solidity.js";
import "prismjs/components/prism-sql.js";
import "prismjs/components/prism-swift.js";
import "prismjs/components/prism-toml.js";
import "prismjs/components/prism-typescript.js";
import "prismjs/components/prism-tsx.js";
import "prismjs/components/prism-yaml.js";

import { cn } from "@/lib/utils";

const languageAliases: Record<string, Language> = {
  "c#": "csharp",
  "c++": "cpp",
  cs: "csharp",
  html: "markup",
  js: "javascript",
  kt: "kotlin",
  kts: "kotlin",
  md: "markdown",
  py: "python",
  rb: "ruby",
  rs: "rust",
  sh: "bash",
  shell: "bash",
  sol: "solidity",
  ts: "typescript",
  xml: "markup",
  yml: "yaml",
  zsh: "bash",
};

const markdownCodeTheme: PrismTheme = {
  plain: {
    backgroundColor: "transparent",
    color: "var(--syntax-foreground)",
  },
  styles: [
    {
      types: ["comment", "prolog", "doctype", "cdata"],
      style: {
        color: "var(--syntax-comment)",
        fontStyle: "italic",
      },
    },
    {
      types: ["punctuation"],
      style: { color: "var(--syntax-punctuation)" },
    },
    {
      types: [
        "property",
        "tag",
        "boolean",
        "number",
        "constant",
        "symbol",
        "deleted",
      ],
      style: { color: "var(--syntax-number)" },
    },
    {
      types: ["selector", "attr-name", "string", "char", "builtin", "inserted"],
      style: { color: "var(--syntax-string)" },
    },
    {
      types: ["operator", "entity", "url", "string-variable"],
      style: { color: "var(--syntax-operator)" },
    },
    {
      types: ["atrule", "attr-value", "function", "class-name"],
      style: { color: "var(--syntax-function)" },
    },
    {
      types: ["keyword"],
      style: {
        color: "var(--syntax-keyword)",
        fontWeight: "600",
      },
    },
    {
      types: ["regex", "important", "variable"],
      style: { color: "var(--syntax-variable)" },
    },
  ],
};

export function markdownCodeLanguage(className?: string): Language | null {
  const languageClass = className
    ?.split(/\s+/u)
    .find((candidate) => candidate.startsWith("language-"));
  if (!languageClass) return null;

  const requestedLanguage = languageClass
    .slice("language-".length)
    .toLowerCase();
  const language = languageAliases[requestedLanguage] ?? requestedLanguage;
  return Object.hasOwn(Prism.languages, language) ? language : null;
}

export function SyntaxHighlightedCode({
  children,
  className,
  ...props
}: React.ComponentProps<"code">) {
  const language = markdownCodeLanguage(className);
  if (!language) {
    return (
      <code
        {...props}
        className={cn(className, "block min-w-max font-mono text-xs leading-5")}
      >
        {children}
      </code>
    );
  }

  const code = String(children).replace(/\n$/u, "");
  return (
    <Highlight
      code={code}
      language={language}
      prism={Prism}
      theme={markdownCodeTheme}
    >
      {({
        className: highlightedClassName,
        getLineProps,
        getTokenProps,
        style,
        tokens,
      }) => (
        <code
          {...props}
          className={cn(
            className,
            highlightedClassName,
            "block min-w-max font-mono text-xs leading-5",
          )}
          style={{ ...style, background: "transparent" }}
        >
          {tokens.map((line, lineIndex) => (
            <span key={lineIndex} {...getLineProps({ line })}>
              {line.map((token, tokenIndex) => (
                <span key={tokenIndex} {...getTokenProps({ token })} />
              ))}
              {lineIndex < tokens.length - 1 ? "\n" : null}
            </span>
          ))}
        </code>
      )}
    </Highlight>
  );
}

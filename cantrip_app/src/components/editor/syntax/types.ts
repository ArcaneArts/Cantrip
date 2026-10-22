export type LanguageId =
  | "plain"
  | "javascript"
  | "typescript"
  | "jsx"
  | "tsx"
  | "rust"
  | "dart"
  | "python"
  | "go"
  | "java"
  | "groovy"
  | "kotlin"
  | "swift"
  | "c"
  | "cpp"
  | "csharp"
  | "ruby"
  | "php"
  | "lua"
  | "html"
  | "xml"
  | "css"
  | "scss"
  | "json"
  | "jsonc"
  | "yaml"
  | "toml"
  | "markdown"
  | "shell"
  | "batch"
  | "sql"
  | "dockerfile"
  | "makefile"
  | "env"
  | "ini"
  | "properties";

export type TokenKind =
  | "text"
  | "keyword"
  | "type"
  | "function"
  | "string"
  | "number"
  | "comment"
  | "operator"
  | "punctuation"
  | "tag"
  | "attribute"
  | "variable"
  | "heading"
  | "literal";

export interface SyntaxToken {
  from: number;
  to: number;
  kind: TokenKind;
}

export interface LanguageDefinition {
  keywords: ReadonlySet<string>;
  types?: ReadonlySet<string>;
  literals?: ReadonlySet<string>;
  lineComments?: readonly string[];
  blockComments?: readonly (readonly [string, string])[];
  quotes?: readonly string[];
  multilineQuotes?: readonly string[];
  caseInsensitive?: boolean;
  nestedComments?: boolean;
  template?: boolean;
  jsx?: boolean;
  hashVariables?: boolean;
}

export interface SyntaxFrame {
  kind:
    | "code"
    | "string"
    | "comment"
    | "markup"
    | "tag"
    | "markdown"
    | "yaml-block";
  language: LanguageId;
  end?: string;
  start?: string;
  depth?: number;
  escaped?: boolean;
  multiline?: boolean;
  interpolate?: boolean;
  closing?: boolean;
  tagName?: string;
  selfClosing?: boolean;
  fence?: string;
}

export interface SyntaxState {
  frames: SyntaxFrame[];
}
export interface SyntaxLine {
  tokens: SyntaxToken[];
  state: SyntaxState;
}
export type LanguageCatalog = Partial<Record<LanguageId, LanguageDefinition>>;

export const words = (value: string): ReadonlySet<string> =>
  new Set(value.split(/\s+/u).filter(Boolean));

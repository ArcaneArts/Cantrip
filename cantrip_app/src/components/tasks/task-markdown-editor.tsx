import {
  BlockTypeSelect,
  BoldItalicUnderlineToggles,
  ChangeCodeMirrorLanguage,
  CodeToggle,
  ConditionalContents,
  CreateLink,
  InsertCodeBlock,
  InsertTable,
  InsertThematicBreak,
  ListsToggle,
  markdownShortcutPlugin,
  MDXEditor,
  type MDXEditorMethods,
  type RealmPlugin,
  Separator,
  StrikeThroughSupSubToggles,
  UndoRedo,
  codeBlockPlugin,
  codeMirrorPlugin,
  headingsPlugin,
  linkDialogPlugin,
  linkPlugin,
  listsPlugin,
  quotePlugin,
  tablePlugin,
  thematicBreakPlugin,
  toolbarPlugin,
} from "@mdxeditor/editor";
import { useEffect, useMemo, useRef, type KeyboardEvent } from "react";

import "./task-markdown-editor.css";

const CODE_BLOCK_LANGUAGES = {
  "": "Plain text",
  bash: "Bash",
  css: "CSS",
  html: "HTML",
  java: "Java",
  javascript: "JavaScript",
  json: "JSON",
  jsx: "JavaScript (React)",
  kotlin: "Kotlin",
  markdown: "Markdown",
  python: "Python",
  rust: "Rust",
  shell: "Shell",
  sql: "SQL",
  tsx: "TypeScript (React)",
  typescript: "TypeScript",
  yaml: "YAML",
};

function TaskMarkdownToolbar() {
  return (
    <ConditionalContents
      options={[
        {
          contents: () => (
            <>
              <UndoRedo />
              <Separator />
              <ChangeCodeMirrorLanguage />
            </>
          ),
          when: (editor) => editor?.editorType === "codeblock",
        },
        {
          fallback: () => (
            <>
              <UndoRedo />
              <Separator />
              <BlockTypeSelect />
              <BoldItalicUnderlineToggles options={["Bold", "Italic"]} />
              <StrikeThroughSupSubToggles options={["Strikethrough"]} />
              <CodeToggle />
              <CreateLink />
              <Separator />
              <ListsToggle />
              <InsertCodeBlock />
              <InsertTable />
              <InsertThematicBreak />
            </>
          ),
        },
      ]}
    />
  );
}

function createTaskMarkdownPlugins(): RealmPlugin[] {
  return [
    headingsPlugin(),
    listsPlugin(),
    quotePlugin(),
    linkPlugin(),
    linkDialogPlugin(),
    tablePlugin(),
    thematicBreakPlugin(),
    codeBlockPlugin({ defaultCodeBlockLanguage: "" }),
    codeMirrorPlugin({ codeBlockLanguages: CODE_BLOCK_LANGUAGES }),
    markdownShortcutPlugin(),
    toolbarPlugin({
      toolbarClassName: "cantrip-task-markdown-toolbar",
      toolbarContents: TaskMarkdownToolbar,
    }),
  ];
}

export function shouldEmitTaskMarkdownChange(
  initialMarkdownNormalize: boolean,
): boolean {
  return !initialMarkdownNormalize;
}

export function shouldSyncTaskMarkdown(
  externalMarkdown: string,
  latestEditorMarkdown: string,
): boolean {
  return externalMarkdown !== latestEditorMarkdown;
}

export function TaskMarkdownEditor({
  ariaLabel,
  onChange,
  onSave,
  placeholder,
  value,
}: {
  ariaLabel: string;
  onChange(value: string): void;
  onSave?(): void;
  placeholder?: string;
  value: string;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<MDXEditorMethods>(null);
  const latestEditorMarkdownRef = useRef(value);
  const plugins = useMemo(createTaskMarkdownPlugins, []);

  useEffect(() => {
    const contentEditable = containerRef.current?.querySelector<HTMLElement>(
      '.mdxeditor-root-contenteditable [contenteditable="true"]',
    );
    contentEditable?.setAttribute("aria-label", ariaLabel);
    contentEditable?.setAttribute("aria-multiline", "true");
  }, [ariaLabel]);

  useEffect(() => {
    if (!shouldSyncTaskMarkdown(value, latestEditorMarkdownRef.current)) return;
    latestEditorMarkdownRef.current = value;
    editorRef.current?.setMarkdown(value);
  }, [value]);

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (
      onSave &&
      (event.metaKey || event.ctrlKey) &&
      event.key.toLowerCase() === "s"
    ) {
      event.preventDefault();
      onSave();
    }
  };

  return (
    <div
      ref={containerRef}
      className="h-full min-h-0"
      onKeyDownCapture={handleKeyDown}
    >
      <MDXEditor
        ref={editorRef}
        className="cantrip-task-markdown-editor mdxeditor-full-height h-full"
        contentEditableClassName="cantrip-task-markdown-content"
        markdown={value}
        placeholder={placeholder}
        plugins={plugins}
        spellCheck
        suppressHtmlProcessing
        toMarkdownOptions={{ bullet: "-", emphasis: "_" }}
        trim={false}
        onChange={(markdown, initialMarkdownNormalize) => {
          latestEditorMarkdownRef.current = markdown;
          if (shouldEmitTaskMarkdownChange(initialMarkdownNormalize)) {
            onChange(markdown);
          }
        }}
      />
    </div>
  );
}

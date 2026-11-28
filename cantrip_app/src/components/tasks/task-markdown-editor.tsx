import {
  BlockTypeSelect,
  BoldItalicUnderlineToggles,
  ButtonWithTooltip,
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
  type Translation,
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
  translation$,
} from "@mdxeditor/editor";
import { Content as PopoverContent } from "@radix-ui/react-popover";
import { Ellipsis } from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  type KeyboardEvent,
} from "react";

import { Popover, PopoverTrigger } from "@/components/ui/popover";

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
              <Popover>
                <PopoverTrigger asChild>
                  <ButtonWithTooltip title="More formatting">
                    <Ellipsis className="size-4" />
                  </ButtonWithTooltip>
                </PopoverTrigger>
                <PopoverContent
                  aria-label="More formatting"
                  className="z-10 grid gap-1 rounded-md border bg-popover p-2 shadow-md"
                  collisionPadding={8}
                  sideOffset={6}
                  onOpenAutoFocus={(event) => event.preventDefault()}
                >
                  <div className="flex items-center gap-1">
                    <StrikeThroughSupSubToggles options={["Strikethrough"]} />
                    <CodeToggle />
                    <CreateLink />
                    <ListsToggle />
                  </div>
                  <div className="flex items-center gap-1">
                    <InsertCodeBlock />
                    <InsertTable />
                    <InsertThematicBreak />
                  </div>
                </PopoverContent>
              </Popover>
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
  readOnly = false,
  value,
}: {
  ariaLabel: string;
  onChange(value: string): void;
  onSave?(): void;
  placeholder?: string;
  readOnly?: boolean;
  value: string;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<MDXEditorMethods>(null);
  const latestEditorMarkdownRef = useRef(value);
  const translation = useCallback<Translation>(
    (key, defaultValue, interpolations = {}) => {
      if (key === "contentArea.editableMarkdown") return ariaLabel;
      for (const [name, value] of Object.entries(interpolations)) {
        defaultValue = defaultValue.replaceAll(`{{${name}}}`, String(value));
      }
      return defaultValue;
    },
    [ariaLabel],
  );
  const plugins = useMemo<RealmPlugin[]>(
    () => [
      ...createTaskMarkdownPlugins(),
      { update: (realm) => realm.pub(translation$, translation) },
    ],
    [translation],
  );

  useEffect(() => {
    const contentEditable = containerRef.current?.querySelector<HTMLElement>(
      ".mdxeditor-root-contenteditable [contenteditable]",
    );
    contentEditable?.setAttribute("aria-multiline", "true");
  }, [readOnly]);

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
      className="h-full min-h-0 min-w-0"
      onKeyDownCapture={handleKeyDown}
    >
      <MDXEditor
        ref={editorRef}
        className="cantrip-task-markdown-editor mdxeditor-full-height h-full"
        contentEditableClassName="cantrip-task-markdown-content select-text"
        markdown={value}
        placeholder={placeholder}
        plugins={plugins}
        readOnly={readOnly}
        spellCheck
        suppressHtmlProcessing
        toMarkdownOptions={{ bullet: "-", emphasis: "_" }}
        translation={translation}
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

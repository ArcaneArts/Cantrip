import Editor, { loader, type OnMount } from "@monaco-editor/react";
import * as monaco from "monaco-editor";
import { useEffect, useRef, useState } from "react";

import CssWorker from "./monaco-workers/css.worker.js?worker";
import EditorWorker from "./monaco-workers/editor.worker.js?worker";
import HtmlWorker from "./monaco-workers/html.worker.js?worker";
import JsonWorker from "./monaco-workers/json.worker.js?worker";
import TsWorker from "./monaco-workers/ts.worker.js?worker";

globalThis.MonacoEnvironment = {
  getWorker(_moduleId: string, label: string) {
    if (label === "json") return new JsonWorker();
    if (label === "css" || label === "scss" || label === "less") {
      return new CssWorker();
    }
    if (label === "html" || label === "handlebars" || label === "razor") {
      return new HtmlWorker();
    }
    if (label === "typescript" || label === "javascript") {
      return new TsWorker();
    }
    return new EditorWorker();
  },
};

loader.config({ monaco });

function currentTheme(): "light" | "vs-dark" | "hc-light" | "hc-black" {
  const classes = document.documentElement.classList;
  if (classes.contains("high-contrast")) {
    return classes.contains("dark") ? "hc-black" : "hc-light";
  }
  return classes.contains("dark") ? "vs-dark" : "light";
}

export function MonacoFileEditor({
  language,
  modelPath,
  onChange,
  onSave,
  value,
}: {
  language: string;
  modelPath: string;
  onChange(value: string): void;
  onSave(): void;
  value: string;
}) {
  const [theme, setTheme] = useState(currentTheme);
  const onSaveRef = useRef(onSave);
  onSaveRef.current = onSave;

  useEffect(() => {
    const observer = new MutationObserver(() => setTheme(currentTheme()));
    observer.observe(document.documentElement, {
      attributeFilter: ["class"],
      attributes: true,
    });
    return () => observer.disconnect();
  }, []);

  const handleMount: OnMount = (editor) => {
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
      onSaveRef.current();
    });
    editor.focus();
  };

  return (
    <div className="h-full" data-selectable-text="true">
      <Editor
        height="100%"
        language={language}
        onChange={(nextValue) => onChange(nextValue ?? "")}
        onMount={handleMount}
        options={{
          automaticLayout: true,
          fontFamily:
            "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
          fontSize: 13,
          minimap: { enabled: true },
          padding: { bottom: 12, top: 12 },
          scrollBeyondLastLine: false,
          smoothScrolling: true,
          tabSize: 2,
        }}
        path={modelPath}
        theme={theme}
        value={value}
      />
    </div>
  );
}

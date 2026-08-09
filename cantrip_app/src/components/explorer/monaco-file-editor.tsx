import Editor, { loader, type OnMount } from "@monaco-editor/react";
import * as monaco from "monaco-editor";
import CssWorker from "monaco-vs/language/css/css.worker.js?worker";
import HtmlWorker from "monaco-vs/language/html/html.worker.js?worker";
import JsonWorker from "monaco-vs/language/json/json.worker.js?worker";
import TsWorker from "monaco-vs/language/typescript/ts.worker.js?worker";
import EditorWorker from "monaco-vs/editor/editor.worker.js?worker";
import { useEffect, useRef, useState } from "react";

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
  );
}

import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { NativeFileWindowCloseGuard } from "@/components/app/native-file-window-close-guard";
import { Button } from "@/components/ui/button";
import { EditorDocumentSession } from "../document-session";
import { NativeCodeEditor } from "../native-code-editor";
import "@/index.css";

function Fixture() {
  const [document, setDocument] = useState<EditorDocumentSession | null>(null);
  const [, redraw] = useState(0);
  const [error, setError] = useState("");
  useEffect(() => {
    void fetch("/__qa/files/main.tsx")
      .then((response) => response.json())
      .then((file: { content: string; version: string }) =>
        setDocument(
          new EditorDocumentSession("main.tsx", file.content, file.version),
        ),
      );
  }, []);
  const save = async () => {
    if (!document) return;
    const pending = document.save(async (input) => {
      const response = await fetch("/__qa/files/main.tsx", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input),
      });
      if (!response.ok) throw new Error("Fixture save failed");
      return response.json() as Promise<{ version: string }>;
    });
    redraw((value) => value + 1);
    try {
      await pending;
    } catch (failure) {
      setError(String(failure));
    }
    redraw((value) => value + 1);
  };
  return (
    <main className="flex h-dvh flex-col bg-background text-foreground">
      <NativeFileWindowCloseGuard
        hasUnsavedChanges={() => Boolean(document?.dirty || document?.saving)}
      />
      <nav className="flex items-center gap-3 border-b p-3">
        <span>main.tsx</span>
        <Button onClick={() => void save()}>Save</Button>
        <output aria-label="Save state">
          {document?.saving ? "saving" : document?.dirty ? "unsaved" : "saved"}
        </output>
        <output aria-label="Save error">{error}</output>
      </nav>
      <section className="flex min-h-0 flex-1">
        {document && (
          <NativeCodeEditor
            session={document}
            path="main.tsx"
            onChange={() => redraw((value) => value + 1)}
            onSave={() => void save()}
          />
        )}
      </section>
    </main>
  );
}
createRoot(window.document.getElementById("root")!).render(<Fixture />);

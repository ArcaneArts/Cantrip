import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  EditorSessionStore,
  type EditorDocumentSession,
} from "../document-session";
import { NativeCodeEditor } from "../native-code-editor";

const store = new EditorSessionStore();
function Fixture() {
  const [path, setPath] = useState("main.tsx");
  const [session, setSession] = useState<EditorDocumentSession | null>(null);
  const [error, setError] = useState("");
  const [status, setStatus] = useState("loading");
  const [visible, setVisible] = useState(true);
  const [, redraw] = useState(0);
  useEffect(() => {
    let cancelled = false;
    const cached = store.get(path);
    setSession(cached ?? null);
    if (cached) {
      setStatus(cached.dirty ? "unsaved" : "saved");
      return;
    }
    void fetch(`/__qa/files/${path}`)
      .then(async (response) => {
        if (!response.ok) throw new Error("File load failed");
        return response.json() as Promise<{ content: string; version: string }>;
      })
      .then((file) => {
        if (!cancelled) {
          setSession(store.open(path, file.content, file.version));
          setStatus("saved");
        }
      })
      .catch((failure: unknown) => {
        if (!cancelled) setError(String(failure));
      });
    return () => {
      cancelled = true;
    };
  }, [path]);
  const save = async () => {
    if (!session) return;
    setError("");
    setStatus("saving");
    try {
      await session.save(async ({ content, version }) => {
        const response = await fetch(`/__qa/files/${session.id}`, {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ content, version }),
        });
        if (!response.ok)
          throw new Error(
            response.status === 409
              ? "File changed externally"
              : "File save failed",
          );
        return response.json() as Promise<{ version: string }>;
      });
      setStatus(session.dirty ? "unsaved" : "saved");
      redraw((value) => value + 1);
    } catch (failure) {
      setError(String(failure));
      setStatus("unsaved");
    }
  };
  return (
    <main
      style={{ height: "100dvh", display: "flex", flexDirection: "column" }}
    >
      <nav style={{ display: "flex", gap: 8, padding: 8, flexWrap: "wrap" }}>
        {["main.tsx", "other.py", "large.ts"].map((file) => (
          <button
            key={file}
            onClick={() => {
              setPath(file);
              setError("");
            }}
          >
            {file}
          </button>
        ))}
        <button onClick={() => void save()}>Save</button>
        <button onClick={() => setVisible((value) => !value)}>
          {visible ? "Hide editor" : "Show editor"}
        </button>
        <button
          onClick={() => {
            document.documentElement.classList.toggle("dark");
          }}
        >
          Theme
        </button>
        <output aria-label="Save state" data-saving={session?.saving ?? false}>
          {status}
        </output>
        <output aria-label="Error">{error}</output>
      </nav>
      <section
        style={{ minHeight: 0, flex: 1, display: visible ? "flex" : "none" }}
      >
        {session && session.id === path && (
          <NativeCodeEditor
            session={session}
            path={path}
            active={visible}
            onSave={() => void save()}
            onChange={() => {
              setStatus(session.dirty ? "unsaved" : "saved");
              redraw((value) => value + 1);
            }}
          />
        )}
      </section>
    </main>
  );
}
createRoot(document.getElementById("root")!).render(<Fixture />);

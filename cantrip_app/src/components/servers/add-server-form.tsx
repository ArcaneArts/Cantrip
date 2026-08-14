import { Loader2 } from "lucide-react";
import { useState, type FormEvent } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  saveServerConnection,
  testServerConnection,
  type ServerConnection,
} from "@/lib/server-connections";

type AddServerFormProps = {
  autoFocus?: boolean;
  onSaved(connection: ServerConnection): Promise<void> | void;
  submitLabel?: string;
};

export function AddServerForm({
  autoFocus = false,
  onSaved,
  submitLabel = "Save and switch",
}: AddServerFormProps) {
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [testing, setTesting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [testResult, setTestResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const test = async () => {
    setTesting(true);
    setError(null);
    setTestResult(null);
    try {
      const bootstrap = await testServerConnection(url);
      setTestResult(
        `Connected to ${bootstrap.server.id} · ${
          bootstrap.auth.state === "authenticated"
            ? "ready"
            : bootstrap.auth.mode === "password"
              ? "password required"
              : "sign-in required"
        }`,
      );
    } catch (connectionError) {
      setError(
        connectionError instanceof Error
          ? connectionError.message
          : "Could not connect to that server.",
      );
    } finally {
      setTesting(false);
    }
  };

  const save = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    setSaving(true);
    try {
      const connection = await saveServerConnection({ name, url });
      await onSaved(connection);
    } catch (saveError) {
      setError(
        saveError instanceof Error
          ? saveError.message
          : "Could not save server.",
      );
    } finally {
      setSaving(false);
    }
  };

  return (
    <form className="grid gap-5" onSubmit={save}>
      <label className="grid gap-2 text-sm">
        Name
        <Input
          autoFocus={autoFocus}
          onChange={(event) => setName(event.target.value)}
          placeholder="Home server"
          required
          value={name}
        />
      </label>
      <label className="grid gap-2 text-sm">
        Server URL
        <Input
          inputMode="url"
          onChange={(event) => {
            setUrl(event.target.value);
            setError(null);
            setTestResult(null);
          }}
          placeholder="https://cantrip.example"
          required
          value={url}
        />
      </label>
      {testResult ? (
        <p className="text-sm text-emerald-500">{testResult}</p>
      ) : null}
      {error ? <p className="text-sm text-destructive">{error}</p> : null}
      <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        <Button
          disabled={saving || testing}
          onClick={() => void test()}
          type="button"
          variant="outline"
        >
          {testing ? <Loader2 className="size-4 animate-spin" /> : null}
          Test connection
        </Button>
        <Button disabled={saving || testing} type="submit">
          {saving ? <Loader2 className="size-4 animate-spin" /> : null}
          {submitLabel}
        </Button>
      </div>
    </form>
  );
}

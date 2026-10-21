import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SyntaxDocument, textChange } from "./document";
import { languageForFile, loadLanguage } from "./languages";
import type { SyntaxRequest, SyntaxResponse } from "./worker-protocol";

const posted = vi.fn<(response: SyntaxResponse) => void>();
const worker = {
  onmessage: null as ((event: MessageEvent<SyntaxRequest>) => void) | null,
  postMessage: posted,
};

beforeEach(async () => {
  vi.resetModules();
  posted.mockClear();
  vi.stubGlobal("self", worker);
  await import("./syntax.worker");
});
afterEach(() => vi.unstubAllGlobals());

async function send(message: SyntaxRequest): Promise<SyntaxResponse> {
  const count = posted.mock.calls.length;
  worker.onmessage!({ data: message } as MessageEvent<SyntaxRequest>);
  await vi.waitFor(() => expect(posted).toHaveBeenCalledTimes(count + 1));
  return posted.mock.calls[count]![0];
}

async function fresh(path: string, text: string) {
  const language = languageForFile(path, text);
  return new SyntaxDocument(
    text,
    language,
    await loadLanguage(language),
  ).highlight(0, 20);
}

describe("syntax worker language changes", () => {
  it("re-detects added, replaced, and removed shebangs after real edit messages", async () => {
    const path = "scripts/run";
    let text = "class Example:\n  pass\n";
    let revision = 0;
    const open = await send({
      type: "open",
      documentId: path,
      revision,
      path,
      text,
      first: 0,
      last: 20,
    });
    expect(open.lines).toEqual(await fresh(path, text));
    for (const next of [
      "#!/usr/bin/env python3\nclass Example:\n  pass\n",
      "#!/usr/bin/env node\nconst example = true;\n",
      "const example = true;\n",
    ]) {
      const response = await send({
        type: "edit",
        documentId: path,
        revision: revision + 1,
        baseRevision: revision,
        change: textChange(text, next),
        first: 0,
        last: 20,
      });
      expect(response.lines).toEqual(await fresh(path, next));
      expect(response.revision).toBe(++revision);
      text = next;
    }
  });

  it("retains extension precedence and rejects edits for the wrong revision or document", async () => {
    const path = "main.py";
    const text = "#!/usr/bin/env node\nclass Example:\n  pass\n";
    await send({
      type: "open",
      documentId: path,
      revision: 2,
      path,
      text,
      first: 0,
      last: 20,
    });
    for (const [documentId, baseRevision] of [
      [path, 0],
      ["other", 2],
    ] as const)
      worker.onmessage!({
        data: {
          type: "edit",
          documentId,
          baseRevision,
          revision: 3,
          change: textChange(text, "invalid overwrite"),
          first: 0,
          last: 20,
        },
      } as MessageEvent<SyntaxRequest>);
    const response = await send({
      type: "viewport",
      documentId: path,
      revision: 2,
      first: 0,
      last: 20,
    });
    expect(response.lines).toEqual(await fresh(path, text));
    expect(
      response.lines[1]!.tokens.some((token) => token.kind === "keyword"),
    ).toBe(true);
  });
});

/// <reference lib="webworker" />
import { SyntaxDocument } from "./document";
import { languageForFile, loadLanguage } from "./languages";
import type { SyntaxRequest, SyntaxResponse } from "./worker-protocol";

const worker = self as unknown as DedicatedWorkerGlobalScope;
let document: SyntaxDocument | null = null;
let documentId = "";
let documentPath = "";
let revision = -1;
let queue = Promise.resolve();

worker.onmessage = (event: MessageEvent<SyntaxRequest>) => {
  const message = event.data;
  queue = queue
    .then(async () => {
      if (message.type === "open") {
        const language = languageForFile(message.path, message.text);
        const catalog = await loadLanguage(language);
        document = new SyntaxDocument(message.text, language, catalog);
        documentId = message.documentId;
        documentPath = message.path;
        revision = message.revision;
      } else if (documentId !== message.documentId || !document) return;
      else if (message.type === "edit") {
        if (message.baseRevision !== revision) return;
        document.apply(message.change);
        const language = languageForFile(documentPath, document.lines[0]);
        if (language !== document.language) {
          const catalog = await loadLanguage(language);
          document = new SyntaxDocument(
            document.lines.join("\n"),
            language,
            catalog,
          );
        }
        revision = message.revision;
      }
      if (message.revision !== revision || !document) return;
      const response: SyntaxResponse = {
        documentId,
        revision,
        first: message.first,
        lines: document.highlight(message.first, message.last),
      };
      worker.postMessage(response);
    })
    .catch(() => {
      // Rendering remains plain text. Private file content and parser errors are
      // never forwarded to logs or telemetry, and input does not depend on us.
      worker.postMessage({
        documentId: message.documentId,
        revision: message.revision,
        first: message.first,
        lines: [],
      } satisfies SyntaxResponse);
    });
};

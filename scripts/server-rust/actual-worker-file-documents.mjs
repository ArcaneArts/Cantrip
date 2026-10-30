// Existing encrypted document API -> real server -> unchanged full worker/files.
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
async function authorize(page, workerId) {
  await page.evaluate(async (workerId) => {
    const { ensureSurfacePrivateStateWorkerEncryption } =
      await import("/src/lib/surface-private-state-worker-encryption.ts");
    const worker = (await window.folderWorkers.getWorkers()).find(
      (w) => w.workerId === workerId,
    );
    await ensureSurfacePrivateStateWorkerEncryption({ worker });
  }, workerId);
}
export async function actualWorkerFileDocuments({
  page,
  projectId,
  workerId,
  directory,
  result,
}) {
  const id = crypto.randomUUID(),
    token = "private-document-" + crypto.randomUUID();
  const file = token + ".txt",
    other = token + "-other.txt";
  const initial = "Original encrypted file 🌿\n",
    content =
      token + "\n" + "File document encrypted payload 🌙\n".repeat(1200);
  await writeFile(path.join(directory, file), initial);
  await writeFile(
    path.join(directory, other),
    "Unrelated file remains unchanged.\n",
  );
  const requests = [],
    responses = [];
  const capture = (request) => {
    const pathname = new URL(request.url()).pathname;
    if (pathname.startsWith("/api/") && pathname.includes("/file-documents"))
      requests.push({
        pathname,
        method: request.method(),
        body: request.postData(),
      });
  };
  const response = (value) => {
    const pathname = new URL(value.url()).pathname;
    if (pathname.startsWith("/api/") && pathname.includes("/file-documents"))
      responses.push({ pathname, status: value.status() });
  };
  page.on("request", capture);
  page.on("response", response);
  try {
    await authorize(page, workerId);
    const binding = await page.evaluate(
      async ({ projectId, workerId, id, file }) => {
        const { post } = await import("/src/lib/api-client.ts");
        const placement = (
          await post(
            `/api/projects/${encodeURIComponent(projectId)}/placement/resolve`,
            { surfaceKind: "explorer" },
          )
        ).placement;
        if (placement.workerId !== workerId)
          throw new Error("Unexpected file document worker placement");
        const api = await import("/src/lib/api/file-documents.ts");
        const binding = {
          id,
          projectId,
          workerId,
          worktreeId: placement.worktreeId,
          path: file,
        };
        const created = await api.createFileDocument(binding);
        const retry = await api.createFileDocument(binding);
        const listed = await api.getFileDocuments(projectId);
        const raw = await window.folderRequest(`/api/file-documents/${id}`);
        return { binding, created, retry, listed, raw };
      },
      { projectId, workerId, id, file },
    );
    assert.equal(binding.created.path, file);
    assert.equal(binding.retry.path, file);
    assert.equal(binding.created.createdAt, binding.retry.createdAt);
    assert.equal(binding.listed.find((d) => d.id === id)?.path, file);
    assert.equal(
      JSON.stringify(binding.raw).includes(file),
      false,
      "catalog keeps the document location opaque",
    );
    const outcomes = await page.evaluate(
      async ({ binding, initial, content, other }) => {
        const api = await import("/src/lib/api/file-documents.ts");
        const failure = async (run) => {
          try {
            await run();
            return { accepted: true };
          } catch (e) {
            return { message: e.message, status: e.status ?? null };
          }
        };
        const first = await api.executeFileDocumentOperation(binding.id, {
          type: "explorer.file.read",
          path: binding.path,
        });
        if (first.value.content !== initial)
          throw new Error("Actual initial file differs");
        const written = await api.executeFileDocumentOperation(binding.id, {
          type: "explorer.file.write",
          path: binding.path,
          content,
          version: first.value.version,
        });
        const stale = await failure(() =>
          api.executeFileDocumentOperation(binding.id, {
            type: "explorer.file.write",
            path: binding.path,
            content: "Rejected stale write",
            version: first.value.version,
          }),
        );
        const wrongPath = await failure(() =>
          api.executeFileDocumentOperation(binding.id, {
            type: "explorer.file.read",
            path: other,
          }),
        );
        const wrongLocation = await failure(() =>
          api.createFileDocument({ ...binding, path: other }),
        );
        const operationId = crypto.randomUUID();
        const read = await api.executeFileDocumentOperation(
          binding.id,
          { type: "explorer.file.read", path: binding.path },
          operationId,
        );
        const replay = await failure(() =>
          api.executeFileDocumentOperation(
            binding.id,
            { type: "explorer.file.read", path: binding.path },
            operationId,
          ),
        );
        return {
          first,
          written,
          stale,
          wrongPath,
          wrongLocation,
          read,
          replay,
        };
      },
      { binding: binding.binding, initial, content, other },
    );
    assert.equal(outcomes.written.value.content, content);
    assert.equal(outcomes.read.value.content, content);
    assert.deepEqual(outcomes.stale, {
      message: "This file changed on disk. Reload it before saving your edits.",
      status: null,
    });
    assert.deepEqual(outcomes.wrongPath, {
      message: "The operation does not target this file document.",
      status: null,
    });
    assert.deepEqual(outcomes.wrongLocation, {
      message: "File document identity belongs to a different location.",
      status: 409,
    });
    assert.deepEqual(outcomes.replay, {
      message: "Protected surface operation was already completed.",
      status: 502,
    });
    assert.equal(await readFile(path.join(directory, file), "utf8"), content);
    assert.equal(
      await readFile(path.join(directory, other), "utf8"),
      "Unrelated file remains unchanged.\n",
    );
    const serialized = JSON.stringify(requests);
    assert.equal(
      serialized.includes(token),
      false,
      "private file paths/content do not enter server requests",
    );
    assert.equal(
      serialized.includes(directory),
      false,
      "worker filesystem root does not enter document HTTP requests",
    );
    assert.equal(
      responses.filter((r) => r.status === 409).length,
      2,
      "fresh-nonce retries and different locations use immutable conflict responses",
    );
    result.fileDocuments = {
      bytes: Buffer.byteLength(content),
      requests,
      responses,
      replayRejected: true,
      staleWriteRejected: true,
      locationRejected: true,
    };
    result.steps.push(
      "existing file-document client creates an opaque immutable location and resolves fresh-nonce retries without relocation",
      "full worker decrypts document operations, reads and writes actual file bytes, and rejects stale saves and a different file",
      "worker replay protection rejects repeated document operations and HTTP captures contain no private file path or contents",
    );
    return { ...binding.binding, content, directory };
  } finally {
    page.off("request", capture);
    page.off("response", response);
  }
}
export async function retainedWorkerFileDocument({
  page,
  workerId,
  document,
  result,
}) {
  await authorize(page, workerId);
  const value = await page.evaluate(async ({ id, projectId, path }) => {
    const api = await import("/src/lib/api/file-documents.ts");
    const stored = (await api.getFileDocuments(projectId)).find(
      (d) => d.id === id,
    );
    return {
      stored,
      read: await api.executeFileDocumentOperation(id, {
        type: "explorer.file.read",
        path,
      }),
    };
  }, document);
  assert.equal(value.stored?.path, document.path);
  assert.equal(value.read.value.content, document.content);
  assert.equal(
    await readFile(path.join(document.directory, document.path), "utf8"),
    document.content,
  );
  result.steps.push(
    "server and full worker restart retain document identity and encrypted access to the same saved file bytes",
  );
}

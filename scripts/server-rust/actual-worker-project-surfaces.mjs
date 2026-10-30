// Existing browser encryption and APIs, full worker, and real disposable files.
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
export async function actualWorkerProjectSurfaces({
  page,
  projectId,
  workerId,
  directory,
  result,
}) {
  const token = "private-surface-" + crypto.randomUUID(),
    file = token + ".txt",
    content = token + "\n" + "Encrypted Explorer save 🌿\n".repeat(3000);
  await writeFile(path.join(directory, file), "Original file\n");
  const requests = [],
    responses = [];
  const relevant = (url) =>
    /\/api\/(?:projects\/[^/]+\/(?:explorers|code-tabs|views)|explorers\/|code-tabs\/|project-views\/)/.test(
      new URL(url).pathname,
    );
  const capture = (request) => {
    if (relevant(request.url()))
      requests.push({
        path: new URL(request.url()).pathname,
        method: request.method(),
        body: request.postData(),
      });
  };
  const response = (value) => {
    if (relevant(value.url()))
      responses.push({
        path: new URL(value.url()).pathname,
        status: value.status(),
      });
  };
  page.on("request", capture);
  page.on("response", response);
  try {
    await authorize(page, workerId);
    const value = await page.evaluate(
      async ({ projectId, workerId, file, content, token }) => {
        const explorers = await import("/src/lib/api/explorers.ts"),
          code = await import("/src/lib/api/code.ts"),
          files = await import("/src/lib/api/files.ts"),
          views = await import("/src/lib/api/project-views.ts");
        const fail = async (run) => {
          try {
            await run();
            return { accepted: true };
          } catch (e) {
            return { message: e.message, status: e.status ?? null };
          }
        };
        const explorer = await explorers.createExplorer(
          projectId,
          token,
          undefined,
          undefined,
          undefined,
          {
            attachToTabLayout: false,
            initialViewState: { selectedPath: file, fileMode: "edit" },
          },
        );
        const renamed = await explorers.renameExplorer(
          explorer.id,
          token + " renamed",
        );
        const pinned = await explorers.pinExplorer(
          explorer.id,
          token + " pinned",
          { selectedPath: file, fileMode: "edit" },
        );
        const retried = await explorers.pinExplorer(
          explorer.id,
          "Ignored retry",
          { selectedPath: null, fileMode: "visual" },
          "missing-pane",
        );
        const updated = await explorers.updateExplorerViewState(explorer.id, {
          selectedPath: file,
          fileMode: "visual",
        });
        const binding = {
          workerId,
          projectId,
          worktreeId: explorer.worktreeId,
        };
        const first = await files.getExplorerFile(explorer.id, file, binding);
        const written = await files.saveExplorerFile(
          explorer.id,
          { path: file, content, version: first.version },
          binding,
        );
        const stale = await fail(() =>
          files.saveExplorerFile(
            explorer.id,
            {
              path: file,
              content: "Rejected stale edit",
              version: first.version,
            },
            binding,
          ),
        );
        const moved = await fail(() =>
          files.saveExplorerFile(
            explorer.id,
            {
              path: file,
              content: "Rejected checkout edit",
              version: written.version,
            },
            { ...binding, worktreeId: crypto.randomUUID() },
          ),
        );
        const tab = await code.createCodeTab(projectId, token + " code");
        const renamedCode = await code.updateCodeTab(tab.id, {
          title: token + " code renamed",
        });
        const noGitView = await fail(() =>
          views.createProjectView(projectId, "history", token + " history"),
        );
        const duplicate = await explorers.createExplorer(
          projectId,
          "Disposable Explorer",
        );
        await explorers.deleteExplorer(duplicate.id);
        const disposableCode = await code.createCodeTab(
          projectId,
          "Disposable Code",
        );
        await code.deleteCodeTab(disposableCode.id);
        return {
          explorer,
          renamed,
          pinned,
          retried,
          updated,
          first,
          written,
          stale,
          moved,
          tab,
          renamedCode,
          noGitView,
          explorers: await explorers.getExplorers(projectId),
          code: await code.getCodeTabs(projectId),
        };
      },
      { projectId, workerId, file, content, token },
    );
    assert.equal(value.renamed.title, token + " renamed");
    assert.equal(value.pinned.title, token + " pinned");
    assert.deepEqual(value.retried, value.pinned);
    assert.equal(value.updated.selectedPath, file);
    assert.equal(value.updated.fileMode, "visual");
    assert.equal(value.first.content, "Original file\n");
    assert.equal(value.written.content, content);
    assert.deepEqual(value.stale, {
      message: "This file changed on disk. Reload it before saving your edits.",
      status: null,
    });
    assert.deepEqual(value.moved, {
      message:
        "This Explorer moved to another checkout. Reopen the file there; your draft has not been saved.",
      status: 409,
    });
    assert.equal(value.renamedCode.title, token + " code renamed");
    assert.equal(value.noGitView.status, 409);
    assert.equal(value.explorers.length, 1);
    assert.equal(value.code.length, 1);
    assert.equal(await readFile(path.join(directory, file), "utf8"), content);
    assert.equal(
      JSON.stringify(requests).includes(token),
      false,
      "private titles, paths and contents stay opaque on HTTP",
    );
    result.projectSurfaces = {
      requests,
      responses,
      bytes: Buffer.byteLength(content),
    };
    result.steps.push(
      "existing Explorer client creates, renames, pins, retries and stores encrypted view state; Code client creates, renames and deletes tabs",
      "full worker decrypts Explorer operations and saves real file bytes while rejecting stale versions and mismatched checkout bindings",
    );
    return {
      id: value.explorer.id,
      codeId: value.tab.id,
      projectId,
      workerId,
      file,
      content,
      directory,
      title: token + " pinned",
      codeTitle: token + " code renamed",
    };
  } finally {
    page.off("request", capture);
    page.off("response", response);
  }
}
export async function retainedWorkerProjectSurfaces({ page, surface, result }) {
  await authorize(page, surface.workerId);
  const value = await page.evaluate(async (surface) => {
    const explorers = await import("/src/lib/api/explorers.ts"),
      code = await import("/src/lib/api/code.ts"),
      files = await import("/src/lib/api/files.ts");
    const explorer = (await explorers.getExplorers(surface.projectId)).find(
      (v) => v.id === surface.id,
    );
    const tab = (await code.getCodeTabs(surface.projectId)).find(
      (v) => v.id === surface.codeId,
    );
    const read = await files.getExplorerFile(surface.id, surface.file, {
      workerId: surface.workerId,
      projectId: surface.projectId,
      worktreeId: explorer.worktreeId,
    });
    await explorers.deleteExplorer(surface.id);
    await code.deleteCodeTab(surface.codeId);
    return {
      explorer,
      tab,
      read,
      remainingExplorers: await explorers.getExplorers(surface.projectId),
      remainingCode: await code.getCodeTabs(surface.projectId),
    };
  }, surface);
  assert.equal(value.explorer.title, surface.title);
  assert.equal(value.explorer.selectedPath, surface.file);
  assert.equal(value.explorer.fileMode, "visual");
  assert.equal(value.tab.title, surface.codeTitle);
  assert.equal(value.read.content, surface.content);
  assert.equal(value.remainingExplorers.length, 0);
  assert.equal(value.remainingCode.length, 0);
  assert.equal(
    await readFile(path.join(surface.directory, surface.file), "utf8"),
    surface.content,
  );
  result.steps.push(
    "server and full worker restart preserve encrypted Explorer and Code state and saved bytes; deleting resources retains the actual file",
  );
}

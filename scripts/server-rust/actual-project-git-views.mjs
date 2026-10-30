// Real local Git discovery, existing browser encryption, and durable view APIs.
import assert from "node:assert/strict";

export async function actualProjectGitViews({ page, projectId, result }) {
  const title = "Private Git view " + crypto.randomUUID();
  const requests = [];
  const capture = (request) => {
    if (/\/api\/(?:projects\/[^/]+\/views|project-views\/)/.test(request.url()))
      requests.push(request.postData());
  };
  page.on("request", capture);
  try {
    const value = await page.evaluate(
      async ({ projectId, title }) => {
        const views = await import("/src/lib/api/project-views.ts");
        const explorers = await import("/src/lib/api/explorers.ts");
        const explorer = await explorers.createExplorer(
          projectId,
          "Git checkout selector",
        );
        const history = await views.createProjectView(
          projectId,
          "history",
          title,
          explorer.worktreeId,
        );
        const graph = await views.createProjectView(
          projectId,
          "graph",
          title + " graph",
          explorer.worktreeId,
        );
        const renamed = await views.renameProjectView(
          history.id,
          title + " renamed",
        );
        let selection;
        try {
          await views.updateProjectViewWorktree(
            history.id,
            explorer.worktreeId,
          );
          selection = { accepted: true };
        } catch (error) {
          selection = { status: error.status, message: error.message };
        }
        const listed = await views.getProjectViews(projectId);
        await views.deleteProjectView(graph.id);
        await explorers.deleteExplorer(explorer.id);
        return {
          history,
          graph,
          renamed,
          selection,
          listed,
          remaining: await views.getProjectViews(projectId),
        };
      },
      { projectId, title },
    );
    assert.equal(value.history.title, title);
    assert.equal(value.graph.title, title + " graph");
    assert.equal(value.renamed.title, title + " renamed");
    assert.deepEqual(value.selection, {
      status: 409,
      message:
        "This managed-folder project does not support the worktrees capability.",
    });
    assert.ok(value.history.worktreeId);
    assert.equal(value.listed.length, 2);
    assert.deepEqual(value.remaining, [value.renamed]);
    assert.equal(
      JSON.stringify(requests).includes(title),
      false,
      "Git view titles stay opaque on HTTP",
    );
    result.gitViewRequests = requests;
    result.steps.push(
      "actual Git checkout discovered by full worker supports encrypted History/Graph creation, rename and deletion; existing browser receives the required worktree-switch capability denial for managed folders",
    );
    return {
      projectId,
      id: value.history.id,
      title: title + " renamed",
      worktreeId: value.history.worktreeId,
    };
  } finally {
    page.off("request", capture);
  }
}

export async function retainedProjectGitViews({ page, view, result }) {
  const value = await page.evaluate(async (view) => {
    const views = await import("/src/lib/api/project-views.ts");
    const retained = await views.getProjectViews(view.projectId);
    await views.deleteProjectView(view.id);
    return { retained, remaining: await views.getProjectViews(view.projectId) };
  }, view);
  assert.equal(value.retained.length, 1);
  assert.equal(value.retained[0].id, view.id);
  assert.equal(value.retained[0].title, view.title);
  assert.equal(value.retained[0].worktreeId, view.worktreeId);
  assert.deepEqual(value.remaining, []);
  result.steps.push(
    "server and full worker restart preserve encrypted Git view title and checkout binding; retained view can be deleted",
  );
}

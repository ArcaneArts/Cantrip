// Calls the real Node repository; only the test connector owns disposable data.
export async function conversionFixture(repo, request) {
  const {
    op,
    owner,
    project,
    worker,
    source,
    input,
    job,
    command,
    attempt,
    revision,
    error,
    result,
  } = request;
  switch (op) {
    case "conversion-create":
      return repo.create(owner, project, worker, source, input);
    case "conversion-get":
      return repo.get(owner, project);
    case "conversion-active":
      return repo.hasActiveProjectJob(project);
    case "conversion-source":
      return repo.convertedManagedFolderSource(owner, project);
    case "conversion-is-source":
      return repo.isConvertedManagedFolderSource(owner, project, source);
    case "conversion-claim":
      return repo.claimNext();
    case "conversion-renew":
      return repo.renewLease(job, command, attempt);
    case "conversion-block":
      return repo.block(job, command, error);
    case "conversion-fail":
      return repo.fail(job, command, error);
    case "conversion-complete":
      return repo.complete(job, command, result);
    case "conversion-retry":
      return repo.retry(owner, project, revision);
    case "conversion-recover":
      return repo.recoverInterrupted(request.force, new Date(request.now));
    case "conversion-requeue":
      return repo.requeueRetryableForWorker(worker);
    default:
      throw new Error("Unknown conversion fixture operation " + op);
  }
}

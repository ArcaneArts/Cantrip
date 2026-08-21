-- Pre-release cutover: existing project-domain rows may contain plaintext
-- repository paths, branch names, status snapshots, and setup errors. New
-- worker results use stable opaque routing handles whose plaintext mapping
-- exists only in the authorized worker's mode-0600 routing registry. Existing
-- rows cannot be converted without asking a worker to reveal their paths to
-- the server, so discard the affected disposable project domain instead of
-- retaining a plaintext compatibility path.
DELETE FROM "projects";

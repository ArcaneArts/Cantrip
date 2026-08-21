-- Pre-release cutover: managed Git operation context, refs, paths, output,
-- and errors now remain on the authorized worker and cross the server only
-- inside repository-content envelopes. Remove legacy server-readable rows so
-- an upgraded server cannot return a plaintext operation snapshot.
DELETE FROM "git_operations";

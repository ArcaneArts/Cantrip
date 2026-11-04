# GitHub Actions usage

GitHub Actions is reserved for releases and deployments. Run development,
pull-request, compatibility and diagnostic checks locally. Do not add or restore
hosted validation triggers, dispatch validation workflows, or wait for hosted
validation before delivering an ordinary change.

Keep the release-branch native bundle pipeline and the explicitly dispatched
managed-runtime release pipeline. Their release builds may validate what they
ship. Files in `workflow-archive/` are inactive reference recipes; do not move
them back into `workflows/` for development testing.

Record actual local validation in each pull request. Do not describe canceled or
unrun hosted checks as passing. Follow the canonical manual-change protocol for
worktree, pull-request and merge delivery.

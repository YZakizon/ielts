# Repository Guidance

- For every new task or bug fix, create a new branch and a separate worktree before making changes. Do not continue work on an existing feature branch unless the user explicitly says that branch owns the task.
- Do not create task worktrees under `/tmp`; it can be erased after reboot. Use `/home/yeffry/Documents/project/tmp` instead.
- After a pull request is merged, clean up the task branch and any temporary worktree created for that work. Do not delete unrelated branches, worktrees, or remote branches unless explicitly asked.
- For releases and deployments, use an explicit release tag so rollback is straightforward. Example: `TAG=0.1 make docker-build-run`.
- When the user says "release and deploy", check the latest GitHub release version, increment it, create a new GitHub release tag, and deploy that release tag to production `td340`.
- Before GitHub operations, run `gh auth status` and confirm the active account is using a valid system-keyring credential. If `gh` reports an invalid credential from `hosts.yml`, recheck for a keyring-backed login before declaring authentication blocked. Never print or expose the token.

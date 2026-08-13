# Repository Guidance

- For every new task or bug fix, create a new branch and a separate worktree before making changes. Do not continue work on an existing feature branch unless the user explicitly says that branch owns the task.
- Do not create task worktrees under `/tmp`; it can be erased after reboot. Use `/home/yeffry/Documents/project/tmp` instead.
- After a pull request is merged, clean up the task branch and any temporary worktree created for that work. Do not delete unrelated branches, worktrees, or remote branches unless explicitly asked.

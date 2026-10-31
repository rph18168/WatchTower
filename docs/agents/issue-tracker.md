# Issue tracker: GitHub

Issues and specs live in GitHub Issues for `rph18168/WatchTower`.
Use the `gh` CLI for tracker operations.

## Target and body text

Before the first tracker write in a session, run
`gh repo view --json nameWithOwner` and verify the target is
`rph18168/WatchTower`. Use `--repo rph18168/WatchTower` when needed.

For multiline bodies, write the exact text to a UTF-8 temporary file
and pass it with `--body-file`.

## Conventions

- Create: `gh issue create --title "..." --body-file <path>`.
- Read: `gh issue view <n> --json number,title,body,labels,comments`.
- List: `gh issue list --state open --json number,title,body,labels,assignees`, with appropriate label and state filters.
- Parent/child: `gh issue create --parent <parent> ...` or `gh issue edit <parent> --add-sub-issue <child>`.
- Blocking: use native issue dependencies with `gh issue create --blocked-by <n>,<n> ...` or `gh issue edit <child> --add-blocked-by <blocker>`.
- Count open blockers: `gh api repos/rph18168/WatchTower/issues/<n> --jq .issue_dependencies_summary.blocked_by`. A ticket is startable when every blocker is closed.
- Comment: `gh issue comment <n> --body-file <path>`.
- Apply/remove labels: `gh issue edit <n> --add-label "..."` or `--remove-label "..."`.
- Close: post the explanation with `gh issue comment <n> --body-file <path>`, then run `gh issue close <n>`. For an already-closed issue, post the comment directly.

If native sub-issues are unavailable, put `Part of #<parent>` at the
top of the child body and add it to the parent's task list.
If native dependencies are unavailable, use a `Blocked by: #<n>, #<n>`
line at the top of the child body and check each blocker's state.

## Pull requests as a triage surface

**PRs as a request surface: no.**

## Skill operations

- "Publish to the issue tracker" means create a GitHub issue.
- "Fetch the relevant ticket" means read the GitHub issue and its comments.

## Wayfinding operations

Used by `/wayfinder`.

- Map: one issue labelled `wayfinder:map`, containing Notes / Decisions-so-far / Fog.
- Child: a sub-issue labelled `wayfinder:<type>` where type is `research`, `prototype`, `grilling`, or `task`. Use the parent/child fallback above when needed.
- Frontier: take the map's open children in map order, excluding those with open blockers or an assignee; the first remaining child wins.
- Claim: `gh issue edit <n> --add-assignee @me`, the session's first write.
- Resolve: comment with the answer, close the child, then append a gist and link to the map's Decisions-so-far.

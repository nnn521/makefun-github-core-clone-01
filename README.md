# makefun-github-core-clone-01

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/nnn521/makefun-github-core-clone-01/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/nnn521/makefun-github-core-clone-01/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A standalone GitHub-compatible git forge: one Node 22 process serving git smart HTTP (protocol v2 and v0), REST v3, GraphQL and MCP from its own in-memory store. No runtime dependencies, no git binary, no database — repositories, issues, pull requests and git objects all live in one process with deterministic timestamps, so two runs on the same scenario behave identically.

## Run it

```sh
node main.ts
```

In a make.fun trial the process picks its own port, registers it with `$MAKEFUN_ENV_URL`, and polls `/done` until the run ends. Locally (no `MAKEFUN_ENV_URL` set) it serves on `PORT` (default 3000) forever; set `MAKEFUN_SHOP_TOKEN` to the bearer token clients must present (default `dev-token`).

## What it serves

- **Git smart HTTP** — `info/refs` advertisements (upload-pack v2 with `fetch`/`ls-refs`, v0 with `symref`), v2 `ls-refs` and `fetch` (shallow/deepen, have-exclusion), v0 fetch, and `receive-pack` with fast-forward checks and per-ref reports. Packs are read (OFS/REF deltas resolved) and written as plain objects.
- **REST v3** — repos, branches, commits, contents (real git objects, so a file written over REST is fetchable over git), labels, issues, comments, pull requests, and squash merges with three-way conflict detection.
- **GraphQL** — a small real parser and executor: `viewer`, `repository`, `node`, `__type` introspection, issue/PR connections with cursor pagination, and the `createIssue`/`closeIssue`/`createPullRequest`/`mergePullRequest`/`addComment` mutations.
- **MCP** — JSON-RPC 2.0 over Streamable HTTP, revision `2026-07-28` (`server/discover`) with the legacy `initialize` handshake as a fallback; eight tools (`create_repo`, `get_repo`, `create_issue`, `list_issues`, `get_issue`, `create_pull_request`, `merge_pull_request`, `list_pull_requests`).

## Layout

- `main.ts` — entrypoint: trial lifecycle (register, poll `/done`) and local dev mode.
- `app.ts` — HTTP server, auth, routing.
- `git.ts` — git smart HTTP handlers.
- `rest.ts` — REST v3 routes.
- `graphql.ts` — GraphQL tokenizer, parser and executor.
- `mcp.ts` — MCP JSON-RPC dispatcher and tools.
- `store.ts` — repositories, issues, pulls, and the git helpers (trees, merge-base, diffs, squash merges).
- `gitobj.ts` — git objects, pkt-lines and packfiles.
- `config.ts` — shared constants (viewer, fixed timestamps, token).

---

<sub>Entered on [make.fun](https://make.fun/?ref=jbnq2trd&utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards</sub>

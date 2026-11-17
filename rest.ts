// REST v3 API: repos, branches, commits, contents, labels, issues, comments, pulls.
// All timestamps are the fixed deterministic constant; ids are numeric and stable.

import { FIXED_ISO, VIEWER } from './config.ts';
import { parseCommit, parseTree } from './gitobj.ts';
import {
  branchTip,
  buildTreeFromMap,
  commitFiles,
  commitOnBranch,
  diffFiles,
  issueGlobalId,
  mergeBase,
  mergeConflicts,
  peelToCommit,
  pullGlobalId,
  putObject,
  repoGlobalId,
  resolveRef,
  squashMerge,
  type Issue,
  type Pull,
  type Repo,
  type Store,
} from './store.ts';

export interface ReqCtx {
  method: string;
  pathname: string;
  query: URLSearchParams;
  body: unknown;
  /** The raw request body text (used by the MCP handler to tell a parse error from null). */
  bodyText: string;
  host: string;
  store: Store;
}

export interface Resp {
  status: number;
  headers?: Record<string, string>;
  body: string | Buffer;
}

export function json(status: number, data: unknown, headers?: Record<string, string>): Resp {
  return {
    status,
    headers: { 'content-type': 'application/json', ...(headers ?? {}) },
    body: JSON.stringify(data),
  };
}

export function jsonError(status: number, message: string): Resp {
  return json(status, { message });
}

function notFound(): Resp {
  return jsonError(404, 'Not Found');
}

function viewerJson() {
  return { login: VIEWER.login, id: VIEWER.id, type: 'User', name: VIEWER.name, email: VIEWER.email };
}

export function repoJson(repo: Repo): Record<string, unknown> {
  const openIssues = [...repo.issues.values()].filter((issue) => issue.state === 'open').length
    + [...repo.pulls.values()].filter((pull) => pull.state === 'open').length;
  return {
    id: repo.id,
    node_id: repoGlobalId(repo),
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner, id: VIEWER.id, type: 'User' },
    private: repo.private,
    description: repo.description,
    default_branch: repo.defaultBranch,
    created_at: FIXED_ISO,
    updated_at: FIXED_ISO,
    html_url: `https://example.invalid/${repo.owner}/${repo.name}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}`,
    clone_url: `https://example.invalid/${repo.owner}/${repo.name}.git`,
    git_url: `git://example.invalid/${repo.owner}/${repo.name}.git`,
    ssh_url: `git@example.invalid:${repo.owner}/${repo.name}.git`,
    has_issues: true,
    forks_count: 0,
    stargazers_count: 0,
    open_issues_count: openIssues,
    watchers_count: 0,
    size: 0,
    language: null,
    topics: [],
    visibility: repo.private ? 'private' : 'public',
  };
}

export function issueJson(repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    node_id: issueGlobalId(repo, issue),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((label) => ({ name: label.name, color: label.color })),
    user: viewerJson(),
    assignee: null,
    assignees: [],
    locked: false,
    comments: (repo.comments.get(issue.number) ?? []).length,
    created_at: FIXED_ISO,
    updated_at: FIXED_ISO,
    closed_at: issue.state === 'closed' ? FIXED_ISO : null,
    html_url: `https://example.invalid/${repo.owner}/${repo.name}/issues/${issue.number}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
    repository_url: `/api/v3/repos/${repo.owner}/${repo.name}`,
  };
}

export function commentJson(repo: Repo, issueNumber: number, comment: { id: number; body: string }): Record<string, unknown> {
  return {
    id: comment.id,
    body: comment.body,
    user: viewerJson(),
    created_at: FIXED_ISO,
    updated_at: FIXED_ISO,
    html_url: `https://example.invalid/${repo.owner}/${repo.name}/issues/${issueNumber}#issuecomment-${comment.id}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issueNumber}/comments/${comment.id}`,
  };
}

export function pullJson(repo: Repo, pull: Pull): Record<string, unknown> {
  const headSha = branchTip(repo, pull.headRef) ?? pull.headSha;
  const baseSha = branchTip(repo, pull.baseRef) ?? pull.baseSha;
  let mergeable: boolean | null = null;
  if (pull.state === 'open' && headSha !== undefined && baseSha !== undefined) {
    const base = mergeBase(repo, baseSha, headSha);
    mergeable = !mergeConflicts(repo, base, baseSha, headSha);
  }
  return {
    id: pull.id,
    node_id: pullGlobalId(repo, pull),
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    head: {
      ref: pull.headRef,
      sha: headSha,
      label: `${repo.owner}:${pull.headRef}`,
      user: viewerJson(),
      repo: repoJson(repo),
    },
    base: {
      ref: pull.baseRef,
      sha: baseSha,
      label: `${repo.owner}:${pull.baseRef}`,
      user: viewerJson(),
      repo: repoJson(repo),
    },
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    mergeable,
    draft: false,
    created_at: FIXED_ISO,
    updated_at: FIXED_ISO,
    closed_at: pull.state === 'closed' ? FIXED_ISO : null,
    html_url: `https://example.invalid/${repo.owner}/${repo.name}/pull/${pull.number}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/pulls/${pull.number}`,
  };
}

// ---------------------------------------------------------------------------------------------
// pagination
// ---------------------------------------------------------------------------------------------

function pageParams(query: URLSearchParams): { page: number; perPage: number } {
  const page = Math.max(1, Number.parseInt(query.get('page') ?? '1', 10) || 1);
  const perPage = Math.min(100, Math.max(1, Number.parseInt(query.get('per_page') ?? '30', 10) || 30));
  return { page, perPage };
}

function pageUrl(ctx: ReqCtx, page: number): string {
  const query = new URLSearchParams(ctx.query);
  query.set('page', String(page));
  return `http://${ctx.host}${ctx.pathname}?${query.toString()}`;
}

function paginate<T>(ctx: ReqCtx, items: readonly T[]): { page: T[]; link: string | undefined } {
  const { page, perPage } = pageParams(ctx.query);
  const start = (page - 1) * perPage;
  const pageItems = items.slice(start, start + perPage);
  const lastPage = Math.max(1, Math.ceil(items.length / perPage));
  const links: string[] = [];
  if (page < lastPage) links.push(`<${pageUrl(ctx, page + 1)}>; rel="next"`);
  if (lastPage > 1) links.push(`<${pageUrl(ctx, lastPage)}>; rel="last"`);
  if (page > 1) links.push(`<${pageUrl(ctx, page - 1)}>; rel="prev"`);
  return { page: pageItems, link: links.length > 0 ? links.join(', ') : undefined };
}

// ---------------------------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------------------------

function bodyObject(ctx: ReqCtx): Record<string, unknown> {
  if (ctx.body !== null && typeof ctx.body === 'object' && !Array.isArray(ctx.body)) {
    return ctx.body as Record<string, unknown>;
  }
  return {};
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function splitBranch(value: string): string {
  // GitHub accepts `owner:branch`; the suite passes plain branch names.
  const colon = value.indexOf(':');
  return colon >= 0 ? value.slice(colon + 1) : value;
}

/** Split a git identity line (`Name <email> 1700000000 +0000`) into name and email. */
function parseIdentity(line: string): { name: string; email: string } {
  const open = line.indexOf('<');
  const close = line.indexOf('>', open + 1);
  if (open < 0 || close < 0) return { name: line.trim(), email: '' };
  return { name: line.slice(0, open).trim(), email: line.slice(open + 1, close) };
}

type PathLookup =
  | { kind: 'file'; oid: string; mode: string }
  | { kind: 'dir'; oid: string }
  | null;

/** Find a path in a commit's tree (empty path = the root tree). */
function lookupPath(repo: Repo, commitOid: string, path: string): PathLookup {
  const commit = repo.objects.get(commitOid);
  if (!commit || commit.type !== 'commit') return null;
  let treeOid = parseCommit(commit.data).tree;
  if (path === '') return { kind: 'dir', oid: treeOid };
  const segments = path.split('/').filter((segment) => segment !== '');
  for (let index = 0; index < segments.length; index += 1) {
    const tree = repo.objects.get(treeOid);
    if (!tree || tree.type !== 'tree') return null;
    const entry = parseTree(tree.data).find((candidate) => candidate.name === segments[index]);
    if (!entry) return null;
    const last = index === segments.length - 1;
    if (entry.mode === '40000') {
      if (last) return { kind: 'dir', oid: entry.oid };
      treeOid = entry.oid;
    } else if (last) {
      return { kind: 'file', oid: entry.oid, mode: entry.mode };
    } else {
      return null;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------------------------
// router
// ---------------------------------------------------------------------------------------------

/** Handle a REST request; returns null when the path is not a REST route. */
export function handleRest(ctx: ReqCtx): Resp | null {
  const { method, pathname } = ctx;
  const segments = pathname.split('/').filter((segment) => segment !== '').map((segment) => {
    try {
      return decodeURIComponent(segment);
    } catch {
      return segment;
    }
  });
  if (segments[0] !== 'api' || segments[1] !== 'v3') return null;
  const rest = segments.slice(2);

  // Root and meta (no auth needed; app.ts routes them before the auth check).
  if (rest.length === 0 && method === 'GET') {
    return json(200, {
      current_user_url: '/api/v3/user',
      repository_url: '/api/v3/repos/{owner}/{repo}',
      user_url: '/api/v3/user',
      meta_url: '/api/v3/meta',
    }, { 'X-OAuth-Scopes': 'repo, read:org, user' });
  }
  if (rest.length === 1 && rest[0] === 'meta' && method === 'GET') {
    return json(200, { installed_version: '1.0.0', verifiable_password_authentication: true });
  }
  if (rest.length === 1 && rest[0] === 'user' && method === 'GET') {
    return json(200, viewerJson());
  }

  // POST /user/repos and GET /user/repos
  if (rest.length === 2 && rest[0] === 'user' && rest[1] === 'repos') {
    if (method === 'POST') {
      const body = bodyObject(ctx);
      const name = asString(body.name);
      if (!name) return jsonError(422, 'name is required');
      if (ctx.store.getRepo(VIEWER.login, name) !== undefined) {
        return jsonError(422, `Repository ${name} already exists`);
      }
      const repo = ctx.store.createRepo(
        VIEWER.login,
        name,
        asString(body.description) ?? '',
        body.private === true,
      );
      return json(201, repoJson(repo));
    }
    if (method === 'GET') {
      const repos = ctx.store.listRepos(VIEWER.login);
      const { page, link } = paginate(ctx, repos);
      return json(200, page.map(repoJson), link ? { Link: link } : undefined);
    }
    return notFound();
  }

  // /repos/{owner}/{name}[...]
  if (rest.length >= 3 && rest[0] === 'repos') {
    const owner = rest[1]!;
    const name = rest[2]!;
    const repo = ctx.store.getRepo(owner, name);
    if (repo === undefined) return notFound();
    const tail = rest.slice(3);

    if (tail.length === 0) {
      if (method === 'GET') return json(200, repoJson(repo));
      if (method === 'PATCH') {
        const body = bodyObject(ctx);
        const description = asString(body.description);
        if (description !== undefined) repo.description = description;
        if (typeof body.private === 'boolean') repo.private = body.private;
        return json(200, repoJson(repo));
      }
      if (method === 'DELETE') {
        ctx.store.deleteRepo(owner, name);
        return { status: 204, body: '' };
      }
      return notFound();
    }

    const head = tail[0]!;

    // git refs
    if (head === 'git' && tail[1] === 'refs') {
      if (tail.length === 2 && method === 'POST') {
        const body = bodyObject(ctx);
        const ref = asString(body.ref);
        const sha = asString(body.sha);
        if (!ref || !ref.startsWith('refs/')) return jsonError(422, 'ref must start with refs/');
        if (!sha) return jsonError(422, 'sha is required');
        if (repo.refs.has(ref)) return jsonError(422, `Reference ${ref} already exists`);
        if (!repo.objects.has(sha)) return jsonError(422, `object ${sha} not found`);
        repo.refs.set(ref, sha);
        return json(201, { ref, object: { sha, type: repo.objects.get(sha)!.type } });
      }
      if (tail.length === 2 && method === 'GET') {
        const refs = [...repo.refs.entries()]
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .map(([ref, sha]) => ({ ref, object: { sha, type: repo.objects.get(sha)?.type ?? 'commit' } }));
        return json(200, refs);
      }
      if (tail.length >= 3 && method === 'GET') {
        const ref = tail.slice(2).join('/');
        const oid = repo.refs.get(ref);
        if (oid === undefined) return notFound();
        return json(200, { ref, object: { sha: oid, type: repo.objects.get(oid)?.type ?? 'commit' } });
      }
      return notFound();
    }

    // branches
    if (head === 'branches') {
      if (tail.length === 1 && method === 'GET') {
        const branches = [...repo.refs.entries()]
          .filter(([ref]) => ref.startsWith('refs/heads/'))
          .map(([ref, oid]) => ({ name: ref.slice('refs/heads/'.length), commit: { sha: oid } }))
          .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
        return json(200, branches);
      }
      if (tail.length >= 2 && method === 'GET') {
        const branch = tail.slice(1).join('/');
        const tip = branchTip(repo, branch);
        if (tip === undefined) return notFound();
        return json(200, { name: branch, commit: { sha: tip } });
      }
      return notFound();
    }

    // commits
    if (head === 'commits' && tail.length === 1 && method === 'GET') {
      const ref = ctx.query.get('sha') ?? undefined;
      const tip = resolveRef(repo, ref);
      if (tip === undefined) {
        if (ref !== undefined) return notFound();
        return json(200, []);
      }
      const commits: Array<Record<string, unknown>> = [];
      const seen = new Set<string>();
      const queue = [tip];
      while (queue.length) {
        const oid = queue.shift()!;
        if (seen.has(oid)) continue;
        seen.add(oid);
        const object = repo.objects.get(oid);
        if (!object || object.type !== 'commit') continue;
        const parsed = parseCommit(object.data);
        const author = parseIdentity(parsed.author);
        const committer = parseIdentity(parsed.committer);
        commits.push({
          sha: oid,
          commit: {
            message: parsed.message,
            author: { name: author.name, email: author.email, date: FIXED_ISO },
            committer: { name: committer.name, email: committer.email, date: FIXED_ISO },
            tree: { sha: parsed.tree },
          },
          author: { login: VIEWER.login, id: VIEWER.id },
          committer: { login: VIEWER.login, id: VIEWER.id },
          parents: parsed.parents.map((parent) => ({ sha: parent })),
        });
        for (const parent of parsed.parents) queue.push(parent);
      }
      const { page, link } = paginate(ctx, commits);
      return json(200, page, link ? { Link: link } : undefined);
    }

    // contents
    if (head === 'contents') {
      const path = tail.slice(1).join('/');
      if (method === 'GET') {
        const ref = ctx.query.get('ref') ?? undefined;
        const tip = resolveRef(repo, ref);
        if (tip === undefined) return notFound();
        const found = lookupPath(repo, tip, path);
        if (found === null) return notFound();
        if (found.kind === 'file') {
          const blob = repo.objects.get(found.oid);
          if (!blob) return notFound();
          return json(200, {
            type: 'file',
            encoding: 'base64',
            size: blob.data.length,
            name: path.split('/').pop() ?? path,
            path,
            sha: found.oid,
            content: blob.data.toString('base64'),
            url: `/api/v3/repos/${owner}/${name}/contents/${path}`,
          });
        }
        const tree = repo.objects.get(found.oid);
        if (!tree) return notFound();
        const entries = parseTree(tree.data).map((entry) => {
          const isDir = entry.mode === '40000';
          const blob = isDir ? undefined : repo.objects.get(entry.oid);
          return {
            type: isDir ? 'dir' : 'file',
            name: entry.name,
            path: path === '' ? entry.name : `${path}/${entry.name}`,
            sha: entry.oid,
            size: blob?.data.length ?? 0,
            url: `/api/v3/repos/${owner}/${name}/contents/${path === '' ? entry.name : `${path}/${entry.name}`}`,
          };
        });
        return json(200, entries);
      }
      if (method === 'PUT') {
        const body = bodyObject(ctx);
        const message = asString(body.message);
        const content = asString(body.content);
        if (message === undefined) return jsonError(422, 'message is required');
        if (content === undefined) return jsonError(422, 'content is required');
        const branch = asString(body.branch) ?? repo.defaultBranch;
        const baseCommit = branchTip(repo, branch) ?? branchTip(repo, repo.defaultBranch);
        const files = commitFiles(repo, baseCommit);
        const existing = files.get(path);
        const givenSha = asString(body.sha);
        if (givenSha !== undefined && existing !== undefined && givenSha !== existing.oid) {
          return jsonError(409, 'sha does not match the current file');
        }
        if (givenSha !== undefined && existing === undefined) {
          return jsonError(422, 'file does not exist at the given sha');
        }
        const bytes = Buffer.from(content, 'base64');
        const blobOid = putObject(repo, 'blob', bytes);
        const isUpdate = existing !== undefined;
        files.set(path, { mode: existing?.mode ?? '100644', oid: blobOid });
        const treeOid = buildTreeFromMap(repo, files);
        const commitOid = commitOnBranch(repo, branch, treeOid, message);
        return json(isUpdate ? 200 : 201, {
          content: {
            name: path.split('/').pop() ?? path,
            path,
            sha: blobOid,
            size: bytes.length,
            encoding: 'base64',
            type: 'file',
          },
          commit: { sha: commitOid, message, author: viewerJson(), committer: viewerJson() },
        });
      }
      if (method === 'DELETE') {
        const body = bodyObject(ctx);
        const message = asString(body.message);
        if (message === undefined) return jsonError(422, 'message is required');
        const branch = asString(body.branch) ?? repo.defaultBranch;
        const baseCommit = branchTip(repo, branch) ?? branchTip(repo, repo.defaultBranch);
        const files = commitFiles(repo, baseCommit);
        const existing = files.get(path);
        if (existing === undefined) return notFound();
        const givenSha = asString(body.sha);
        if (givenSha !== undefined && givenSha !== existing.oid) {
          return jsonError(409, 'sha does not match the current file');
        }
        files.delete(path);
        const treeOid = buildTreeFromMap(repo, files);
        const commitOid = commitOnBranch(repo, branch, treeOid, message);
        return json(200, { commit: { sha: commitOid, message } });
      }
      return notFound();
    }

    // labels
    if (head === 'labels') {
      if (tail.length === 1 && method === 'GET') {
        return json(200, [...repo.labels.values()].map((label, index) => ({ id: index + 1, name: label.name, color: label.color })));
      }
      if (tail.length === 1 && method === 'POST') {
        const body = bodyObject(ctx);
        const name = asString(body.name);
        if (!name) return jsonError(422, 'name is required');
        const color = asString(body.color) ?? 'ededed';
        const label = { name, color };
        repo.labels.set(name, label);
        return json(201, { id: repo.labels.size, name, color });
      }
      return notFound();
    }

    // issues
    if (head === 'issues') {
      if (tail.length === 1) {
        if (method === 'POST') {
          const body = bodyObject(ctx);
          const title = asString(body.title);
          if (!title) return jsonError(422, 'title is required');
          const rawLabels = Array.isArray(body.labels) ? body.labels : [];
          const labels: Array<{ name: string; color: string }> = [];
          for (const raw of rawLabels) {
            const labelName = typeof raw === 'string' ? raw : asString((raw as Record<string, unknown>)?.name);
            if (labelName === undefined) continue;
            const label = repo.labels.get(labelName);
            if (!label) return jsonError(422, `label ${labelName} does not exist`);
            labels.push(label);
          }
          const issue = ctx.store.createIssue(repo, title, asString(body.body) ?? '', labels);
          return json(201, issueJson(repo, issue));
        }
        if (method === 'GET') {
          const state = ctx.query.get('state') ?? 'open';
          const direction = ctx.query.get('direction') ?? 'desc';
          let issues = [...repo.issues.values()];
          if (state === 'open') issues = issues.filter((issue) => issue.state === 'open');
          else if (state === 'closed') issues = issues.filter((issue) => issue.state === 'closed');
          issues.sort((a, b) => (direction === 'asc' ? a.number - b.number : b.number - a.number));
          const { page, link } = paginate(ctx, issues);
          return json(200, page.map((issue) => issueJson(repo, issue)), link ? { Link: link } : undefined);
        }
        return notFound();
      }
      const number = Number.parseInt(tail[1]!, 10);
      if (!Number.isInteger(number)) return notFound();
      const issue = repo.issues.get(number);
      if (tail.length === 2) {
        if (issue === undefined) return notFound();
        if (method === 'GET') return json(200, issueJson(repo, issue));
        if (method === 'PATCH') {
          const body = bodyObject(ctx);
          const state = asString(body.state);
          if (state === 'open' || state === 'closed') issue.state = state;
          const title = asString(body.title);
          if (title !== undefined) issue.title = title;
          const bodyText = asString(body.body);
          if (bodyText !== undefined) issue.body = bodyText;
          return json(200, issueJson(repo, issue));
        }
        return notFound();
      }
      if (tail.length === 3 && tail[2] === 'comments') {
        if (issue === undefined) return notFound();
        if (method === 'POST') {
          const body = bodyObject(ctx);
          const text = asString(body.body);
          if (text === undefined) return jsonError(422, 'body is required');
          const comment = ctx.store.createComment(repo, number, text);
          return json(201, commentJson(repo, number, comment));
        }
        if (method === 'GET') {
          const comments = repo.comments.get(number) ?? [];
          return json(200, comments.map((comment) => commentJson(repo, number, comment)));
        }
        return notFound();
      }
      return notFound();
    }

    // pulls
    if (head === 'pulls') {
      if (tail.length === 1) {
        if (method === 'POST') {
          const body = bodyObject(ctx);
          const title = asString(body.title);
          if (!title) return jsonError(422, 'title is required');
          const headRef = splitBranch(asString(body.head) ?? '');
          const baseRef = splitBranch(asString(body.base) ?? repo.defaultBranch);
          if (!headRef) return jsonError(422, 'head is required');
          const headSha = branchTip(repo, headRef);
          const baseSha = branchTip(repo, baseRef);
          if (headSha === undefined) return jsonError(422, `head branch ${headRef} not found`);
          if (baseSha === undefined) return jsonError(422, `base branch ${baseRef} not found`);
          const pull = ctx.store.createPull(repo, title, asString(body.body) ?? '', headRef, baseRef, headSha, baseSha);
          return json(201, pullJson(repo, pull));
        }
        if (method === 'GET') {
          const state = ctx.query.get('state') ?? 'open';
          let pulls = [...repo.pulls.values()];
          if (state === 'open') pulls = pulls.filter((pull) => pull.state === 'open');
          else if (state === 'closed') pulls = pulls.filter((pull) => pull.state === 'closed');
          pulls.sort((a, b) => b.number - a.number);
          const { page, link } = paginate(ctx, pulls);
          return json(200, page.map((pull) => pullJson(repo, pull)), link ? { Link: link } : undefined);
        }
        return notFound();
      }
      const number = Number.parseInt(tail[1]!, 10);
      if (!Number.isInteger(number)) return notFound();
      const pull = repo.pulls.get(number);
      if (pull === undefined) return notFound();
      if (tail.length === 2 && method === 'GET') return json(200, pullJson(repo, pull));
      if (tail.length === 3 && tail[2] === 'files' && method === 'GET') {
        const headSha = branchTip(repo, pull.headRef) ?? pull.headSha;
        const baseSha = branchTip(repo, pull.baseRef) ?? pull.baseSha;
        const base = mergeBase(repo, baseSha, headSha);
        const changes = diffFiles(repo, commitFiles(repo, base), commitFiles(repo, headSha));
        return json(200, changes.map((change) => ({
          filename: change.path,
          status: change.status,
          additions: change.additions,
          deletions: change.deletions,
          changes: change.additions + change.deletions,
        })));
      }
      if (tail.length === 3 && tail[2] === 'merge' && method === 'PUT') {
        if (pull.state !== 'open') return jsonError(405, 'pull request is not open');
        const headSha = branchTip(repo, pull.headRef) ?? pull.headSha;
        const baseSha = branchTip(repo, pull.baseRef) ?? pull.baseSha;
        const base = mergeBase(repo, baseSha, headSha);
        if (mergeConflicts(repo, base, baseSha, headSha)) {
          return jsonError(405, 'merge conflict');
        }
        const body = bodyObject(ctx);
        const message = asString(body.commit_message)
          ?? asString(body.commit_title)
          ?? `Merge pull request #${pull.number} from ${pull.headRef}`;
        const mergeSha = squashMerge(repo, pull.baseRef, headSha, message);
        if (mergeSha === null) return jsonError(405, 'merge conflict');
        pull.state = 'closed';
        pull.merged = true;
        pull.mergedAt = FIXED_ISO;
        pull.mergeCommitSha = mergeSha;
        return json(200, { sha: mergeSha, merged: true, message: 'Pull Request successfully merged' });
      }
      return notFound();
    }

    return notFound();
  }

  return notFound();
}

export { peelToCommit };

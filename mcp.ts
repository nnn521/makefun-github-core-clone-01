// MCP: JSON-RPC 2.0 over Streamable HTTP (single JSON replies, no SSE).
// Speaks the modern 2026-07-28 revision via server/discover, with the legacy
// initialize handshake as a fallback. Never emits an Mcp-Session-Id header.

import { FIXED_ISO, VIEWER } from './config.ts';
import { json, issueJson, pullJson, repoJson, type ReqCtx, type Resp } from './rest.ts';
import {
  branchTip,
  mergeBase,
  mergeConflicts,
  squashMerge,
  type Repo,
  type Store,
} from './store.ts';

const SERVER_NAME = 'makefun-github-forge';
const SERVER_VERSION = '1.0.0';
const MODERN_REVISION = '2026-07-28';

interface ToolDef {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, { type: string; description: string }>;
    required?: string[];
  };
}

// Built once and reused verbatim: two tools/list calls must answer byte-identical lists.
const TOOLS: ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository owned by the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Repository name.' },
        description: { type: 'string', description: 'Repository description.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login.' },
        repo: { type: 'string', description: 'Repository name.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login.' },
        repo: { type: 'string', description: 'Repository name.' },
        title: { type: 'string', description: 'Issue title.' },
        body: { type: 'string', description: 'Issue body.' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository, optionally filtered by state.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login.' },
        repo: { type: 'string', description: 'Repository name.' },
        state: { type: 'string', description: 'Issue state filter: open, closed, or all.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'get_issue',
    description: 'Get a single issue by number.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login.' },
        repo: { type: 'string', description: 'Repository name.' },
        issue_number: { type: 'number', description: 'Issue number.' },
      },
      required: ['owner', 'repo', 'issue_number'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request from one branch into another.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login.' },
        repo: { type: 'string', description: 'Repository name.' },
        title: { type: 'string', description: 'Pull request title.' },
        head: { type: 'string', description: 'Head branch name.' },
        base: { type: 'string', description: 'Base branch name.' },
        body: { type: 'string', description: 'Pull request body.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Squash-merge a pull request into its base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login.' },
        repo: { type: 'string', description: 'Repository name.' },
        pull_number: { type: 'number', description: 'Pull request number.' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
  {
    name: 'list_pull_requests',
    description: 'List pull requests in a repository, optionally filtered by state.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login.' },
        repo: { type: 'string', description: 'Repository name.' },
        state: { type: 'string', description: 'Pull request state filter: open, closed, or all.' },
      },
      required: ['owner', 'repo'],
    },
  },
];

const TOOL_NAMES = new Set(TOOLS.map((tool) => tool.name));

function rpcResult(id: unknown, result: unknown): Resp {
  return json(200, { jsonrpc: '2.0', id: id ?? null, result });
}

function rpcError(id: unknown, code: number, message: string): Resp {
  return json(200, { jsonrpc: '2.0', id: id ?? null, error: { code, message } });
}

function toolResult(result: unknown): Record<string, unknown> {
  return {
    content: [{ type: 'text', text: JSON.stringify(result) }],
    structuredContent: result,
  };
}

function toolError(message: string): Record<string, unknown> {
  return {
    content: [{ type: 'text', text: message }],
    isError: true,
  };
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function splitRef(value: string): string {
  const colon = value.indexOf(':');
  return colon >= 0 ? value.slice(colon + 1) : value;
}

function getRepoOrNull(store: Store, args: Record<string, unknown>): Repo | null {
  const owner = asString(args.owner);
  const repo = asString(args.repo);
  if (owner === undefined || repo === undefined) return null;
  return store.getRepo(owner, repo) ?? null;
}

type ToolHandler = (store: Store, args: Record<string, unknown>) => Record<string, unknown>;

const TOOL_HANDLERS: Record<string, ToolHandler> = {
  create_repo: (store, args) => {
    const name = asString(args.name);
    if (name === undefined || name === '') return toolError('name is required');
    if (store.getRepo(VIEWER.login, name) !== undefined) return toolError(`Repository ${name} already exists`);
    const repo = store.createRepo(VIEWER.login, name, asString(args.description) ?? '', args.private === true);
    return toolResult(repoJson(repo));
  },
  get_repo: (store, args) => {
    const repo = getRepoOrNull(store, args);
    if (repo === null) return toolError('Repository not found');
    return toolResult(repoJson(repo));
  },
  create_issue: (store, args) => {
    const repo = getRepoOrNull(store, args);
    if (repo === null) return toolError('Repository not found');
    const title = asString(args.title);
    if (title === undefined || title === '') return toolError('title is required');
    const issue = store.createIssue(repo, title, asString(args.body) ?? '', []);
    return toolResult(issueJson(repo, issue));
  },
  list_issues: (store, args) => {
    const repo = getRepoOrNull(store, args);
    if (repo === null) return toolError('Repository not found');
    const state = asString(args.state) ?? 'open';
    let issues = [...repo.issues.values()];
    if (state === 'open') issues = issues.filter((issue) => issue.state === 'open');
    else if (state === 'closed') issues = issues.filter((issue) => issue.state === 'closed');
    issues.sort((a, b) => b.number - a.number);
    return toolResult({ issues: issues.map((issue) => issueJson(repo, issue)) });
  },
  get_issue: (store, args) => {
    const repo = getRepoOrNull(store, args);
    if (repo === null) return toolError('Repository not found');
    const number = asNumber(args.issue_number);
    const issue = number === undefined ? undefined : repo.issues.get(number);
    if (issue === undefined) return toolError('Issue not found');
    return toolResult(issueJson(repo, issue));
  },
  create_pull_request: (store, args) => {
    const repo = getRepoOrNull(store, args);
    if (repo === null) return toolError('Repository not found');
    const title = asString(args.title);
    if (title === undefined || title === '') return toolError('title is required');
    const headRef = splitRef(asString(args.head) ?? '');
    const baseRef = splitRef(asString(args.base) ?? repo.defaultBranch);
    if (headRef === '') return toolError('head is required');
    const headSha = branchTip(repo, headRef);
    const baseSha = branchTip(repo, baseRef);
    if (headSha === undefined) return toolError(`head branch ${headRef} not found`);
    if (baseSha === undefined) return toolError(`base branch ${baseRef} not found`);
    const pull = store.createPull(repo, title, asString(args.body) ?? '', headRef, baseRef, headSha, baseSha);
    return toolResult(pullJson(repo, pull));
  },
  merge_pull_request: (store, args) => {
    const repo = getRepoOrNull(store, args);
    if (repo === null) return toolError('Repository not found');
    const number = asNumber(args.pull_number);
    const pull = number === undefined ? undefined : repo.pulls.get(number);
    if (pull === undefined) return toolError('Pull request not found');
    if (pull.state !== 'open') return toolError('pull request is not open');
    const headSha = branchTip(repo, pull.headRef) ?? pull.headSha;
    const baseSha = branchTip(repo, pull.baseRef) ?? pull.baseSha;
    const base = mergeBase(repo, baseSha, headSha);
    if (mergeConflicts(repo, base, baseSha, headSha)) return toolError('merge conflict');
    const mergeSha = squashMerge(repo, pull.baseRef, headSha, `Merge pull request #${pull.number} from ${pull.headRef}`);
    if (mergeSha === null) return toolError('merge conflict');
    pull.state = 'closed';
    pull.merged = true;
    pull.mergedAt = FIXED_ISO;
    pull.mergeCommitSha = mergeSha;
    return toolResult({ sha: mergeSha, merged: true, number: pull.number, message: 'Pull Request successfully merged' });
  },
  list_pull_requests: (store, args) => {
    const repo = getRepoOrNull(store, args);
    if (repo === null) return toolError('Repository not found');
    const state = asString(args.state) ?? 'open';
    let pulls = [...repo.pulls.values()];
    if (state === 'open') pulls = pulls.filter((pull) => pull.state === 'open');
    else if (state === 'closed') pulls = pulls.filter((pull) => pull.state === 'closed');
    pulls.sort((a, b) => b.number - a.number);
    return toolResult({ pull_requests: pulls.map((pull) => pullJson(repo, pull)) });
  },
};

/** Handle POST /mcp. Auth is enforced by the app router before this runs. */
export function handleMcp(ctx: ReqCtx): Resp | null {
  if (ctx.pathname !== '/mcp') return null;
  if (ctx.method !== 'POST') return json(404, { message: 'Not Found' });
  const body = ctx.body;
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    // A body that is not valid JSON reaches here as null with non-empty text.
    if (ctx.bodyText.trim() !== '') {
      return {
        status: 400,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }),
      };
    }
    return rpcError(null, -32600, 'Invalid Request');
  }
  const request = body as Record<string, unknown>;
  const id = request.id;
  const isNotification = id === undefined;
  const method = request.method;
  if (typeof method !== 'string') {
    return isNotification ? { status: 202, body: '' } : rpcError(id, -32600, 'Invalid Request');
  }
  if (isNotification) {
    // Notifications (e.g. notifications/initialized) get an empty 202.
    return { status: 202, body: '' };
  }
  const params = (request.params !== null && typeof request.params === 'object' && !Array.isArray(request.params))
    ? (request.params as Record<string, unknown>)
    : {};

  if (method === 'server/discover') {
    return rpcResult(id, {
      supportedVersions: [MODERN_REVISION],
      capabilities: { tools: {} },
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      _meta: { 'io.modelcontextprotocol/serverInfo': { name: SERVER_NAME, version: SERVER_VERSION } },
    });
  }
  if (method === 'initialize') {
    const offered = typeof params.protocolVersion === 'string' ? params.protocolVersion : '2025-11-25';
    return rpcResult(id, {
      protocolVersion: offered,
      capabilities: { tools: {} },
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
    });
  }
  if (method === 'ping') {
    return rpcResult(id, {});
  }
  if (method === 'tools/list') {
    return rpcResult(id, { tools: TOOLS });
  }
  if (method === 'tools/call') {
    const name = params.name;
    if (typeof name !== 'string') return rpcError(id, -32602, 'Tool name is required');
    if (!TOOL_NAMES.has(name)) return rpcError(id, -32601, `Unknown tool ${name}`);
    const tool = TOOLS.find((candidate) => candidate.name === name)!;
    const args = (params.arguments !== null && typeof params.arguments === 'object' && !Array.isArray(params.arguments))
      ? (params.arguments as Record<string, unknown>)
      : {};
    for (const required of tool.inputSchema.required ?? []) {
      if (args[required] === undefined || args[required] === null) {
        return rpcError(id, -32602, `Missing required argument ${required}`);
      }
    }
    try {
      return rpcResult(id, TOOL_HANDLERS[name]!(ctx.store, args));
    } catch (err) {
      return rpcResult(id, toolError((err as Error).message));
    }
  }
  return rpcError(id, -32601, `Method not found: ${method}`);
}

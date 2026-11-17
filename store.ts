// The forge's store: repositories, issues, pull requests, labels and comments, plus
// the git-object helpers the REST and GraphQL surfaces need (tree flatten/rebuild,
// merge-base, diffs, squash merges). All in memory, one process, deterministic.

import { DEFAULT_BRANCH, FIXED_EPOCH_SEC, FIXED_ISO, GIT_IDENTITY, VIEWER, ZERO_OID } from './config.ts';
import {
  buildCommit,
  buildTree,
  collectReachable,
  hashObject,
  isObjectId,
  parseCommit,
  parseTag,
  parseTree,
  type GitObject,
  type TreeEntry,
} from './gitobj.ts';

export interface Label {
  name: string;
  color: string;
}

export interface Issue {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: Label[];
  /** Creation order within the repo (monotonic; number works too, but keep it explicit). */
  seq: number;
}

export interface Pull {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  headRef: string;
  baseRef: string;
  /** Branch tips at creation, used when a branch is later deleted. */
  headSha: string;
  baseSha: string;
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  seq: number;
}

export interface Comment {
  id: number;
  body: string;
  seq: number;
}

export interface Repo {
  id: number;
  owner: string;
  name: string;
  description: string;
  private: boolean;
  defaultBranch: string;
  createdSeq: number;
  objects: Map<string, GitObject>;
  refs: Map<string, string>;
  labels: Map<string, Label>;
  issues: Map<number, Issue>;
  pulls: Map<number, Pull>;
  comments: Map<number, Comment[]>;
  nextNumber: number;
  nextCommentId: number;
}

let repoIdSeq = 1;
let objectIdSeq = 1;
let repoSeq = 1;

function nextGlobalId(): number {
  return objectIdSeq++;
}

/** Opaque, stable global (Relay) ids: base64url of `Kind:key`. Decodable by this server. */
export function encodeGlobalId(kind: string, key: string): string {
  return Buffer.from(`${kind}:${key}`, 'utf8').toString('base64url');
}

export function decodeGlobalId(id: string): { kind: string; key: string } | null {
  try {
    const text = Buffer.from(id, 'base64url').toString('utf8');
    const colon = text.indexOf(':');
    if (colon <= 0) return null;
    return { kind: text.slice(0, colon), key: text.slice(colon + 1) };
  } catch {
    return null;
  }
}

export function repoGlobalId(repo: Repo): string {
  return encodeGlobalId('Repository', `${repo.owner}/${repo.name}`);
}

export function issueGlobalId(repo: Repo, issue: Issue): string {
  return encodeGlobalId('Issue', `${repo.owner}/${repo.name}#${issue.number}`);
}

export function pullGlobalId(repo: Repo, pull: Pull): string {
  return encodeGlobalId('PullRequest', `${repo.owner}/${repo.name}#${pull.number}`);
}

export function commentGlobalId(repo: Repo, comment: Comment): string {
  return encodeGlobalId('Comment', `${repo.owner}/${repo.name}#${comment.id}`);
}

export class Store {
  readonly repos = new Map<string, Repo>();

  key(owner: string, name: string): string {
    return `${owner}/${name}`;
  }

  getRepo(owner: string, name: string): Repo | undefined {
    return this.repos.get(this.key(owner, name));
  }

  listRepos(owner: string): Repo[] {
    const out: Repo[] = [];
    for (const repo of this.repos.values()) if (repo.owner === owner) out.push(repo);
    out.sort((a, b) => a.createdSeq - b.createdSeq);
    return out;
  }

  createRepo(owner: string, name: string, description: string, isPrivate: boolean): Repo {
    const repo: Repo = {
      id: repoIdSeq++,
      owner,
      name,
      description,
      private: isPrivate,
      defaultBranch: DEFAULT_BRANCH,
      createdSeq: repoSeq++,
      objects: new Map(),
      refs: new Map(),
      labels: new Map(),
      issues: new Map(),
      pulls: new Map(),
      comments: new Map(),
      nextNumber: 1,
      nextCommentId: 1,
    };
    this.repos.set(this.key(owner, name), repo);
    return repo;
  }

  deleteRepo(owner: string, name: string): boolean {
    return this.repos.delete(this.key(owner, name));
  }

  createIssue(repo: Repo, title: string, body: string, labels: Label[]): Issue {
    const number = repo.nextNumber++;
    const issue: Issue = { id: nextGlobalId(), number, title, body, state: 'open', labels, seq: number };
    repo.issues.set(number, issue);
    return issue;
  }

  createPull(repo: Repo, title: string, body: string, headRef: string, baseRef: string, headSha: string, baseSha: string): Pull {
    const number = repo.nextNumber++;
    const pull: Pull = {
      id: nextGlobalId(),
      number,
      title,
      body,
      state: 'open',
      headRef,
      baseRef,
      headSha,
      baseSha,
      merged: false,
      mergedAt: null,
      mergeCommitSha: null,
      seq: number,
    };
    repo.pulls.set(number, pull);
    return pull;
  }

  createComment(repo: Repo, issueNumber: number, body: string): Comment {
    const comment: Comment = { id: repo.nextCommentId++, body, seq: repo.nextCommentId };
    const list = repo.comments.get(issueNumber) ?? [];
    list.push(comment);
    repo.comments.set(issueNumber, list);
    return comment;
  }
}

// ---------------------------------------------------------------------------------------------
// git helpers over one repo
// ---------------------------------------------------------------------------------------------

export function refName(branch: string): string {
  return `refs/heads/${branch}`;
}

export function branchTip(repo: Repo, branch: string): string | undefined {
  return repo.refs.get(refName(branch));
}

/** Resolve a ref-ish to a commit oid: a branch name, a full ref, or a 40-hex commit id. */
export function resolveRef(repo: Repo, ref: string | undefined): string | undefined {
  if (ref === undefined || ref === '') return branchTip(repo, repo.defaultBranch);
  if (ref.startsWith('refs/')) {
    const oid = repo.refs.get(ref);
    if (oid === undefined) return undefined;
    return peelToCommit(repo, oid);
  }
  const branch = branchTip(repo, ref);
  if (branch !== undefined) return branch;
  if (isObjectId(ref)) {
    const object = repo.objects.get(ref);
    if (object?.type === 'commit') return ref;
    if (object?.type === 'tag') return peelToCommit(repo, ref);
    return undefined;
  }
  return undefined;
}

/** Follow annotated tags to their commit target (or return the oid unchanged). */
export function peelToCommit(repo: Repo, oid: string): string | undefined {
  let current = oid;
  for (let hops = 0; hops < 10; hops += 1) {
    const object = repo.objects.get(current);
    if (!object) return undefined;
    if (object.type === 'commit') return current;
    if (object.type === 'tag') {
      current = parseTag(object.data).object;
      continue;
    }
    return undefined;
  }
  return undefined;
}

/** Peel a tag ref's target commit for ls-refs/advertisements (undefined when not a tag). */
export function peelTag(repo: Repo, oid: string): string | undefined {
  const object = repo.objects.get(oid);
  if (!object || object.type !== 'tag') return undefined;
  return peelToCommit(repo, oid);
}

/** Whether `ancestor` is reachable from `tip` (following commit parents). */
export function isAncestor(repo: Repo, tip: string, ancestor: string): boolean {
  if (tip === ancestor) return true;
  const seen = new Set<string>();
  const queue = [tip];
  while (queue.length) {
    const oid = queue.pop()!;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const object = repo.objects.get(oid);
    if (!object || object.type !== 'commit') continue;
    for (const parent of parseCommit(object.data).parents) {
      if (parent === ancestor) return true;
      queue.push(parent);
    }
  }
  return false;
}

/** The merge-base of two commits: the first common ancestor in BFS order from `a`. */
export function mergeBase(repo: Repo, a: string, b: string): string | undefined {
  const ancestorsOfB = new Set<string>();
  const queueB = [b];
  while (queueB.length) {
    const oid = queueB.pop()!;
    if (ancestorsOfB.has(oid)) continue;
    ancestorsOfB.add(oid);
    const object = repo.objects.get(oid);
    if (!object || object.type !== 'commit') continue;
    for (const parent of parseCommit(object.data).parents) queueB.push(parent);
  }
  const seen = new Set<string>();
  const queueA = [a];
  while (queueA.length) {
    const oid = queueA.shift()!;
    if (seen.has(oid)) continue;
    seen.add(oid);
    if (ancestorsOfB.has(oid)) return oid;
    const object = repo.objects.get(oid);
    if (!object || object.type !== 'commit') continue;
    for (const parent of parseCommit(object.data).parents) queueA.push(parent);
  }
  return undefined;
}

/** Commits reachable from `tip`, newest first (BFS by generation, parents after children). */
export function listCommits(repo: Repo, tip: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const queue = [tip];
  while (queue.length) {
    const oid = queue.shift()!;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const object = repo.objects.get(oid);
    if (!object || object.type !== 'commit') continue;
    out.push(oid);
    for (const parent of parseCommit(object.data).parents) queue.push(parent);
  }
  return out;
}

/** Flatten a tree into path -> {mode, oid}, recursively. */
export function flattenTree(repo: Repo, treeOid: string, prefix = '', out = new Map<string, { mode: string; oid: string }>()): Map<string, { mode: string; oid: string }> {
  const object = repo.objects.get(treeOid);
  if (!object || object.type !== 'tree') return out;
  for (const entry of parseTree(object.data)) {
    const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.mode === '40000') flattenTree(repo, entry.oid, path, out);
    else if (entry.mode !== '160000') out.set(path, { mode: entry.mode, oid: entry.oid });
  }
  return out;
}

/** Build (and store) a tree from a flat path map. Empty directories are dropped. */
export function buildTreeFromMap(repo: Repo, flat: ReadonlyMap<string, { mode: string; oid: string }>): string {
  interface Node {
    files: Map<string, { mode: string; oid: string }>;
    dirs: Map<string, Node>;
  }
  const make = (): Node => ({ files: new Map(), dirs: new Map() });
  const root = make();
  for (const [path, entry] of flat) {
    const segments = path.split('/');
    let node = root;
    for (let index = 0; index < segments.length - 1; index += 1) {
      const name = segments[index]!;
      let child = node.dirs.get(name);
      if (!child) {
        child = make();
        node.dirs.set(name, child);
      }
      node = child;
    }
    node.files.set(segments[segments.length - 1]!, entry);
  }
  const build = (node: Node): string => {
    const entries: TreeEntry[] = [];
    for (const [name, file] of node.files) entries.push({ mode: file.mode, name, oid: file.oid });
    for (const [name, child] of node.dirs) {
      if (child.files.size === 0 && child.dirs.size === 0) continue;
      entries.push({ mode: '40000', name, oid: build(child) });
    }
    const data = buildTree(entries);
    const oid = hashObject('tree', data);
    if (!repo.objects.has(oid)) repo.objects.set(oid, { type: 'tree', data });
    return oid;
  };
  return build(root);
}

/** Store an object, returning its id. */
export function putObject(repo: Repo, type: 'commit' | 'tree' | 'blob' | 'tag', data: Buffer): string {
  const oid = hashObject(type, data);
  if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
  return oid;
}

/** Create a commit on `branch` whose tree is `treeOid`; returns the commit id. */
export function commitOnBranch(repo: Repo, branch: string, treeOid: string, message: string): string {
  const parent = branchTip(repo, branch) ?? branchTip(repo, repo.defaultBranch);
  const data = buildCommit({
    tree: treeOid,
    parents: parent === undefined ? [] : [parent],
    message,
    author: GIT_IDENTITY,
    committer: GIT_IDENTITY,
    timestamp: FIXED_EPOCH_SEC,
  });
  const oid = putObject(repo, 'commit', data);
  repo.refs.set(refName(branch), oid);
  return oid;
}

/** The flattened file map of a commit (empty when the commit is unknown). */
export function commitFiles(repo: Repo, commitOid: string | undefined): Map<string, { mode: string; oid: string }> {
  if (commitOid === undefined) return new Map();
  const object = repo.objects.get(commitOid);
  if (!object || object.type !== 'commit') return new Map();
  return flattenTree(repo, parseCommit(object.data).tree);
}

// ---------------------------------------------------------------------------------------------
// diffs and merges
// ---------------------------------------------------------------------------------------------

export interface FileChange {
  path: string;
  status: 'added' | 'modified' | 'removed';
  additions: number;
  deletions: number;
}

function countLines(text: string): number {
  if (text === '') return 0;
  const parts = text.split('\n');
  return text.endsWith('\n') ? parts.length - 1 : parts.length;
}

/** A small line diff (LCS over lines) returning added/removed line counts. */
export function diffLineCounts(oldText: string, newText: string): { additions: number; deletions: number } {
  const oldLines = oldText === '' ? [] : oldText.split('\n');
  const newLines = newText === '' ? [] : newText.split('\n');
  if (oldText.endsWith('\n')) oldLines.pop();
  if (newText.endsWith('\n')) newLines.pop();
  const n = oldLines.length;
  const m = newLines.length;
  if (n === 0) return { additions: m, deletions: 0 };
  if (m === 0) return { additions: 0, deletions: n };
  // LCS lengths, two rows.
  let prev = new Array<number>(m + 1).fill(0);
  let curr = new Array<number>(m + 1).fill(0);
  for (let i = 1; i <= n; i += 1) {
    curr[0] = 0;
    for (let j = 1; j <= m; j += 1) {
      curr[j] = oldLines[i - 1] === newLines[j - 1] ? prev[j - 1]! + 1 : Math.max(prev[j]!, curr[j - 1]!);
    }
    [prev, curr] = [curr, prev];
  }
  const lcs = prev[m]!;
  return { additions: m - lcs, deletions: n - lcs };
}

/** The file changes from `baseFiles` to `headFiles`, with line counts. */
export function diffFiles(
  repo: Repo,
  baseFiles: ReadonlyMap<string, { mode: string; oid: string }>,
  headFiles: ReadonlyMap<string, { mode: string; oid: string }>,
): FileChange[] {
  const changes: FileChange[] = [];
  const paths = new Set([...baseFiles.keys(), ...headFiles.keys()]);
  for (const path of [...paths].sort()) {
    const base = baseFiles.get(path);
    const head = headFiles.get(path);
    if (base !== undefined && head === undefined) {
      const blob = repo.objects.get(base.oid);
      changes.push({ path, status: 'removed', additions: 0, deletions: blob ? countLines(blob.data.toString('utf8')) : 0 });
    } else if (base === undefined && head !== undefined) {
      const blob = repo.objects.get(head.oid);
      changes.push({ path, status: 'added', additions: blob ? countLines(blob.data.toString('utf8')) : 0, deletions: 0 });
    } else if (base !== undefined && head !== undefined && base.oid !== head.oid) {
      const oldBlob = repo.objects.get(base.oid);
      const newBlob = repo.objects.get(head.oid);
      const counts = diffLineCounts(
        oldBlob ? oldBlob.data.toString('utf8') : '',
        newBlob ? newBlob.data.toString('utf8') : '',
      );
      changes.push({ path, status: 'modified', additions: counts.additions, deletions: counts.deletions });
    }
  }
  return changes;
}

/** Whether merging `headTip` into `baseTip` (from `mergeBaseOid`) conflicts. */
export function mergeConflicts(
  repo: Repo,
  mergeBaseOid: string | undefined,
  baseTip: string,
  headTip: string,
): boolean {
  const baseFiles = commitFiles(repo, mergeBaseOid);
  const baseNow = commitFiles(repo, baseTip);
  const headNow = commitFiles(repo, headTip);
  const paths = new Set([...baseFiles.keys(), ...baseNow.keys(), ...headNow.keys()]);
  for (const path of paths) {
    const origin = baseFiles.get(path)?.oid;
    const base = baseNow.get(path)?.oid;
    const head = headNow.get(path)?.oid;
    const baseChanged = base !== origin;
    const headChanged = head !== origin;
    if (baseChanged && headChanged && base !== head) return true;
  }
  return false;
}

/**
 * Squash-merge `headTip` into the branch `baseRef` points at. Returns the merge commit id,
 * or null when the merge conflicts. The merged tree is the base tree with the head's
 * changes (relative to the merge-base) applied.
 */
export function squashMerge(repo: Repo, baseRef: string, headTip: string, message: string): string | null {
  const baseTip = branchTip(repo, baseRef);
  if (baseTip === undefined) return null;
  const base = mergeBase(repo, baseTip, headTip);
  if (mergeConflicts(repo, base, baseTip, headTip)) return null;
  const baseFiles = commitFiles(repo, base);
  const baseNow = commitFiles(repo, baseTip);
  const headNow = commitFiles(repo, headTip);
  const merged = new Map(baseNow);
  for (const [path, head] of headNow) {
    if (baseFiles.get(path)?.oid !== head.oid) merged.set(path, head);
  }
  for (const path of baseFiles.keys()) {
    if (!headNow.has(path)) {
      // Deleted on the head side. A base-side change to the same path would be a
      // conflict (already excluded above), so the deletion applies.
      merged.delete(path);
    }
  }
  const treeOid = buildTreeFromMap(repo, merged);
  const data = buildCommit({
    tree: treeOid,
    parents: [baseTip],
    message,
    author: GIT_IDENTITY,
    committer: GIT_IDENTITY,
    timestamp: FIXED_EPOCH_SEC,
  });
  const oid = putObject(repo, 'commit', data);
  repo.refs.set(refName(baseRef), oid);
  return oid;
}

/** The reachable closure helper, for fetch computations. */
export function reachableFrom(repo: Repo, roots: Iterable<string>): Set<string> {
  return collectReachable(roots, (oid) => repo.objects.get(oid), { allowMissing: true });
}

export { FIXED_ISO, VIEWER, ZERO_OID };

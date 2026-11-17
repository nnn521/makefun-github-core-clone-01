// GraphQL: a small real tokenizer, parser and executor for the fixed documents the
// suite sends. Supports queries, mutations, variables, aliases, inline and named
// fragments, object/list/enum arguments, cursor pagination, and __type introspection.

import { VIEWER } from './config.ts';
import { json, type ReqCtx, type Resp } from './rest.ts';
import {
  branchTip,
  commitFiles,
  decodeGlobalId,
  diffFiles,
  issueGlobalId,
  mergeBase,
  mergeConflicts,
  pullGlobalId,
  repoGlobalId,
  squashMerge,
  commentGlobalId,
  type Issue,
  type Pull,
  type Repo,
  type Store,
} from './store.ts';

// ---------------------------------------------------------------------------------------------
// tokenizer
// ---------------------------------------------------------------------------------------------

type Token =
  | { kind: 'name'; value: string }
  | { kind: 'int'; value: string }
  | { kind: 'float'; value: string }
  | { kind: 'string'; value: string }
  | { kind: 'punct'; value: string }
  | { kind: 'eof' };

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const isNameStart = (ch: string): boolean => /[A-Za-z_]/.test(ch);
  const isNameChar = (ch: string): boolean => /[A-Za-z0-9_]/.test(ch);
  const isDigit = (ch: string): boolean => /[0-9]/.test(ch);
  while (i < source.length) {
    const ch = source[i]!;
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',') {
      i += 1;
      continue;
    }
    if (ch === '#') {
      while (i < source.length && source[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '.' && source.slice(i, i + 3) === '...') {
      tokens.push({ kind: 'punct', value: '...' });
      i += 3;
      continue;
    }
    if ('{}():$!@=[]|'.includes(ch)) {
      tokens.push({ kind: 'punct', value: ch });
      i += 1;
      continue;
    }
    if (ch === '"') {
      let value = '';
      i += 1;
      while (i < source.length && source[i] !== '"') {
        if (source[i] === '\\' && i + 1 < source.length) {
          const esc = source[i + 1]!;
          if (esc === 'u' && i + 5 < source.length) {
            value += String.fromCharCode(Number.parseInt(source.slice(i + 2, i + 6), 16));
            i += 6;
          } else {
            value += { n: '\n', t: '\t', r: '\r', b: '\b', f: '\f', '/': '/', '\\': '\\', '"': '"' }[esc] ?? esc;
            i += 2;
          }
        } else {
          value += source[i];
          i += 1;
        }
      }
      i += 1; // closing quote
      tokens.push({ kind: 'string', value });
      continue;
    }
    if (isNameStart(ch)) {
      let value = '';
      while (i < source.length && isNameChar(source[i]!)) {
        value += source[i];
        i += 1;
      }
      tokens.push({ kind: 'name', value });
      continue;
    }
    if (isDigit(ch) || (ch === '-' && isDigit(source[i + 1] ?? ''))) {
      let value = '';
      if (ch === '-') {
        value += '-';
        i += 1;
      }
      while (i < source.length && isDigit(source[i]!)) {
        value += source[i];
        i += 1;
      }
      let isFloat = false;
      if (source[i] === '.' && isDigit(source[i + 1] ?? '')) {
        isFloat = true;
        value += '.';
        i += 1;
        while (i < source.length && isDigit(source[i]!)) {
          value += source[i];
          i += 1;
        }
      }
      if (source[i] === 'e' || source[i] === 'E') {
        isFloat = true;
        value += source[i];
        i += 1;
        if (source[i] === '+' || source[i] === '-') {
          value += source[i];
          i += 1;
        }
        while (i < source.length && isDigit(source[i]!)) {
          value += source[i];
          i += 1;
        }
      }
      tokens.push({ kind: isFloat ? 'float' : 'int', value });
      continue;
    }
    throw new Error(`Unexpected character ${JSON.stringify(ch)} in GraphQL document`);
  }
  tokens.push({ kind: 'eof' });
  return tokens;
}

// ---------------------------------------------------------------------------------------------
// parser
// ---------------------------------------------------------------------------------------------

type ValueNode =
  | { kind: 'variable'; name: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'string'; value: string }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'enum'; value: string }
  | { kind: 'null' }
  | { kind: 'list'; values: ValueNode[] }
  | { kind: 'object'; fields: Record<string, ValueNode> };

interface FieldNode {
  kind: 'field';
  name: string;
  alias?: string;
  arguments: Record<string, ValueNode>;
  selectionSet?: Selection[];
}

interface SpreadNode {
  kind: 'spread';
  name: string;
}

interface InlineNode {
  kind: 'inline';
  typeCondition?: string;
  selectionSet: Selection[];
}

type Selection = FieldNode | SpreadNode | InlineNode;

interface OperationDef {
  kind: 'operation';
  operation: 'query' | 'mutation' | 'subscription';
  name?: string;
  variableDefinitions: Array<{ name: string; defaultValue?: ValueNode }>;
  selectionSet: Selection[];
}

interface FragmentDef {
  kind: 'fragment';
  name: string;
  typeCondition: string;
  selectionSet: Selection[];
}

class Parser {
  private pos = 0;
  private readonly tokens: Token[];

  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token {
    return this.tokens[this.pos]!;
  }

  private next(): Token {
    const token = this.tokens[this.pos]!;
    if (this.pos < this.tokens.length - 1) this.pos += 1;
    return token;
  }

  private expectPunct(value: string): void {
    const token = this.next();
    if (token.kind !== 'punct' || token.value !== value) {
      throw new Error(`Expected "${value}" in GraphQL document`);
    }
  }

  private matchPunct(value: string): boolean {
    const token = this.peek();
    if (token.kind === 'punct' && token.value === value) {
      this.next();
      return true;
    }
    return false;
  }

  private expectName(): string {
    const token = this.next();
    if (token.kind !== 'name') throw new Error('Expected a name in GraphQL document');
    return token.value;
  }

  private matchName(value: string): boolean {
    const token = this.peek();
    if (token.kind === 'name' && token.value === value) {
      this.next();
      return true;
    }
    return false;
  }

  parseDocument(): { operations: OperationDef[]; fragments: Map<string, FragmentDef> } {
    const operations: OperationDef[] = [];
    const fragments = new Map<string, FragmentDef>();
    while (this.peek().kind !== 'eof') {
      const token = this.peek();
      if (token.kind === 'punct' && token.value === '{') {
        operations.push({
          kind: 'operation',
          operation: 'query',
          variableDefinitions: [],
          selectionSet: this.parseSelectionSet(),
        });
        continue;
      }
      if (token.kind === 'name' && (token.value === 'query' || token.value === 'mutation' || token.value === 'subscription')) {
        const operation = token.value as 'query' | 'mutation' | 'subscription';
        this.next();
        let name: string | undefined;
        if (this.peek().kind === 'name') name = this.next().value as string;
        const variableDefinitions = this.parseVariableDefinitions();
        this.parseDirectives();
        operations.push({ kind: 'operation', operation, name, variableDefinitions, selectionSet: this.parseSelectionSet() });
        continue;
      }
      if (token.kind === 'name' && token.value === 'fragment') {
        this.next();
        const name = this.expectName();
        if (!this.matchName('on')) throw new Error('Expected "on" in fragment definition');
        const typeCondition = this.expectName();
        this.parseDirectives();
        fragments.set(name, { kind: 'fragment', name, typeCondition, selectionSet: this.parseSelectionSet() });
        continue;
      }
      throw new Error('Unexpected token in GraphQL document');
    }
    return { operations, fragments };
  }

  private parseVariableDefinitions(): Array<{ name: string; defaultValue?: ValueNode }> {
    const defs: Array<{ name: string; defaultValue?: ValueNode }> = [];
    if (!this.matchPunct('(')) return defs;
    while (!this.matchPunct(')')) {
      this.expectPunct('$');
      const name = this.expectName();
      this.expectPunct(':');
      this.parseType();
      let defaultValue: ValueNode | undefined;
      if (this.matchPunct('=')) defaultValue = this.parseValue(true);
      this.parseDirectives();
      defs.push({ name, defaultValue });
    }
    return defs;
  }

  private parseType(): void {
    if (this.matchPunct('[')) {
      this.parseType();
      this.expectPunct(']');
    } else {
      this.expectName();
    }
    this.matchPunct('!');
  }

  private parseDirectives(): void {
    while (this.peek().kind === 'punct' && this.peek().value === '@') {
      this.next();
      this.expectName();
      if (this.peek().kind === 'punct' && this.peek().value === '(') this.parseArguments();
    }
  }

  private parseSelectionSet(): Selection[] {
    this.expectPunct('{');
    const selections: Selection[] = [];
    while (!this.matchPunct('}')) {
      const token = this.peek();
      if (token.kind === 'punct' && token.value === '...') {
        this.next();
        if (this.peek().kind === 'name' && this.peek().value !== 'on') {
          const name = this.next().value as string;
          this.parseDirectives();
          selections.push({ kind: 'spread', name });
        } else {
          let typeCondition: string | undefined;
          if (this.matchName('on')) typeCondition = this.expectName();
          this.parseDirectives();
          selections.push({ kind: 'inline', typeCondition, selectionSet: this.parseSelectionSet() });
        }
        continue;
      }
      const first = this.expectName();
      let alias: string | undefined;
      let name = first;
      if (this.matchPunct(':')) {
        alias = first;
        name = this.expectName();
      }
      const args = this.parseArguments();
      this.parseDirectives();
      let selectionSet: Selection[] | undefined;
      if (this.peek().kind === 'punct' && this.peek().value === '{') {
        selectionSet = this.parseSelectionSet();
      }
      selections.push({ kind: 'field', name, alias, arguments: args, selectionSet });
    }
    return selections;
  }

  private parseArguments(): Record<string, ValueNode> {
    const args: Record<string, ValueNode> = {};
    if (!this.matchPunct('(')) return args;
    while (!this.matchPunct(')')) {
      const name = this.expectName();
      this.expectPunct(':');
      args[name] = this.parseValue(false);
    }
    return args;
  }

  private parseValue(constant: boolean): ValueNode {
    const token = this.next();
    if (token.kind === 'punct' && token.value === '$' && !constant) {
      return { kind: 'variable', name: this.expectName() };
    }
    if (token.kind === 'int') return { kind: 'int', value: Number.parseInt(token.value, 10) };
    if (token.kind === 'float') return { kind: 'float', value: Number.parseFloat(token.value) };
    if (token.kind === 'string') return { kind: 'string', value: token.value };
    if (token.kind === 'name') {
      if (token.value === 'true') return { kind: 'boolean', value: true };
      if (token.value === 'false') return { kind: 'boolean', value: false };
      if (token.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: token.value };
    }
    if (token.kind === 'punct' && token.value === '[') {
      const values: ValueNode[] = [];
      while (!(this.peek().kind === 'punct' && this.peek().value === ']')) {
        values.push(this.parseValue(constant));
      }
      this.next();
      return { kind: 'list', values };
    }
    if (token.kind === 'punct' && token.value === '{') {
      const fields: Record<string, ValueNode> = {};
      while (!(this.peek().kind === 'punct' && this.peek().value === '}')) {
        const name = this.expectName();
        this.expectPunct(':');
        fields[name] = this.parseValue(constant);
      }
      this.next();
      return { kind: 'object', fields };
    }
    throw new Error('Unexpected value in GraphQL document');
  }
}

function evalValue(node: ValueNode, variables: Record<string, unknown>): unknown {
  switch (node.kind) {
    case 'variable':
      return variables[node.name];
    case 'int':
    case 'float':
    case 'string':
    case 'boolean':
    case 'enum':
      return node.value;
    case 'null':
      return null;
    case 'list':
      return node.values.map((value) => evalValue(value, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(node.fields)) out[key] = evalValue(value, variables);
      return out;
    }
  }
}

// ---------------------------------------------------------------------------------------------
// execution
// ---------------------------------------------------------------------------------------------

type GqlObject = Record<string, unknown> & { __type: string };

interface ExecCtx {
  store: Store;
  variables: Record<string, unknown>;
  fragments: Map<string, FragmentDef>;
  errors: Array<{ message: string }>;
}

const MISSING = Symbol('missing');

type Resolver = (parent: GqlObject, args: Record<string, unknown>, ctx: ExecCtx) => unknown;

const resolvers: Record<string, Record<string, Resolver>> = {};

function field(parent: GqlObject, name: string): unknown {
  return parent[name];
}

function userObject(login: string): GqlObject {
  if (login === VIEWER.login) {
    return { __type: 'User', login: VIEWER.login, id: VIEWER.id, name: VIEWER.name, email: VIEWER.email };
  }
  return { __type: 'User', login, id: 0, name: login, email: '' };
}

function repoObject(repo: Repo): GqlObject {
  return { __type: 'Repository', repo };
}

function issueObject(repo: Repo, issue: Issue): GqlObject {
  return { __type: 'Issue', repo, issue };
}

function pullObject(repo: Repo, pull: Pull): GqlObject {
  return { __type: 'PullRequest', repo, pull };
}

function cursorFor(key: string): string {
  return Buffer.from(`cursor:${key}`, 'utf8').toString('base64url');
}

function cursorKey(cursor: string | undefined): string | undefined {
  if (cursor === undefined) return undefined;
  try {
    const text = Buffer.from(cursor, 'base64url').toString('utf8');
    return text.startsWith('cursor:') ? text.slice('cursor:'.length) : undefined;
  } catch {
    return undefined;
  }
}

interface Page<T> {
  slice: T[];
  hasNextPage: boolean;
  hasPreviousPage: boolean;
  startCursor: string | null;
  endCursor: string | null;
}

function paginate<T>(items: readonly T[], first: number | undefined, after: string | undefined, keyOf: (item: T) => string): Page<T> {
  const afterKey = cursorKey(after);
  let start = 0;
  if (afterKey !== undefined) {
    const index = items.findIndex((item) => keyOf(item) === afterKey);
    start = index >= 0 ? index + 1 : 0;
  }
  const count = first === undefined ? items.length : Math.max(0, first);
  const slice = items.slice(start, start + count);
  const hasNextPage = start + slice.length < items.length;
  return {
    slice,
    hasNextPage,
    hasPreviousPage: start > 0,
    startCursor: slice.length > 0 ? cursorFor(keyOf(slice[0]!)) : null,
    endCursor: slice.length > 0 ? cursorFor(keyOf(slice[slice.length - 1]!)) : null,
  };
}

function orderDirection(orderBy: unknown): 'asc' | 'desc' {
  if (orderBy !== null && typeof orderBy === 'object') {
    const direction = (orderBy as Record<string, unknown>).direction;
    if (direction === 'ASC') return 'asc';
  }
  return 'desc';
}

function issueStateFilter(states: unknown): Set<string> | null {
  if (!Array.isArray(states) || states.length === 0) return null;
  return new Set(states as string[]);
}

function makeIssueConnection(repo: Repo, args: Record<string, unknown>): GqlObject {
  const states = issueStateFilter(args.states);
  let issues = [...repo.issues.values()];
  if (states !== null) {
    issues = issues.filter((issue) => states.has(issue.state === 'open' ? 'OPEN' : 'CLOSED'));
  }
  const direction = orderDirection(args.orderBy);
  issues.sort((a, b) => (direction === 'asc' ? a.number - b.number : b.number - a.number));
  const first = typeof args.first === 'number' ? args.first : undefined;
  const after = typeof args.after === 'string' ? args.after : undefined;
  const page = paginate(issues, first, after, (issue) => String(issue.number));
  return {
    __type: 'IssueConnection',
    repo,
    items: issues,
    page,
    first,
    after,
  };
}

function pullState(pull: Pull): string {
  if (pull.state === 'open') return 'OPEN';
  return pull.merged ? 'MERGED' : 'CLOSED';
}

function makePullConnection(repo: Repo, args: Record<string, unknown>): GqlObject {
  const states = issueStateFilter(args.states);
  let pulls = [...repo.pulls.values()];
  if (states !== null) pulls = pulls.filter((pull) => states.has(pullState(pull)));
  const direction = orderDirection(args.orderBy);
  pulls.sort((a, b) => (direction === 'asc' ? a.number - b.number : b.number - a.number));
  const first = typeof args.first === 'number' ? args.first : undefined;
  const after = typeof args.after === 'string' ? args.after : undefined;
  const page = paginate(pulls, first, after, (pull) => String(pull.number));
  return { __type: 'PullRequestConnection', repo, items: pulls, page, first, after };
}

function connectionFields(kind: 'Issue' | 'PullRequest' | 'File'): Record<string, Resolver> {
  const wrap = (parent: GqlObject, item: unknown): GqlObject => {
    const repo = parent.repo as Repo;
    if (kind === 'Issue') return issueObject(repo, item as Issue);
    if (kind === 'PullRequest') return pullObject(repo, item as Pull);
    return { __type: 'PullRequestChangedFile', path: (item as { path: string }).path };
  };
  return {
    nodes: (parent) => {
      const page = parent.page as Page<unknown>;
      return page.slice.map((item) => wrap(parent, item));
    },
    edges: (parent) => {
      const page = parent.page as Page<unknown>;
      const keyOf = (item: unknown): string => {
        if (kind === 'File') return (item as { path: string }).path;
        return String((item as Issue | Pull).number);
      };
      return page.slice.map((item) => ({
        __type: `${kind}Edge`,
        node: wrap(parent, item),
        cursor: cursorFor(keyOf(item)),
      }));
    },
    pageInfo: (parent) => {
      const page = parent.page as Page<unknown>;
      return {
        __type: 'PageInfo',
        hasNextPage: page.hasNextPage,
        hasPreviousPage: page.hasPreviousPage,
        startCursor: page.startCursor,
        endCursor: page.endCursor,
      };
    },
    totalCount: (parent) => (parent.items as unknown[]).length,
  };
}

const TYPE_FIELDS: Record<string, string[]> = {
  Issue: ['id', 'databaseId', 'number', 'title', 'body', 'state', 'author', 'comments', 'labels', 'createdAt', 'updatedAt'],
  PullRequest: ['id', 'databaseId', 'number', 'title', 'body', 'state', 'headRefName', 'baseRefName', 'mergeable', 'merged', 'files', 'author', 'createdAt', 'updatedAt'],
  Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'createdAt', 'updatedAt'],
  User: ['id', 'login', 'name', 'email'],
  Comment: ['id', 'databaseId', 'body', 'author'],
};

const TYPE_ENUM_VALUES: Record<string, string[]> = {
  SearchType: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION', 'COMMIT', 'CODE'],
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
};

function resolveNode(store: Store, id: unknown): GqlObject | null {
  if (typeof id !== 'string') return null;
  const decoded = decodeGlobalId(id);
  if (decoded === null) return null;
  if (decoded.kind === 'Repository') {
    const slash = decoded.key.indexOf('/');
    if (slash < 0) return null;
    const repo = store.getRepo(decoded.key.slice(0, slash), decoded.key.slice(slash + 1));
    return repo ? repoObject(repo) : null;
  }
  const hash = decoded.key.lastIndexOf('#');
  if (hash < 0) return null;
  const repoKey = decoded.key.slice(0, hash);
  const slash = repoKey.indexOf('/');
  if (slash < 0) return null;
  const repo = store.getRepo(repoKey.slice(0, slash), repoKey.slice(slash + 1));
  if (!repo) return null;
  const number = Number.parseInt(decoded.key.slice(hash + 1), 10);
  if (decoded.kind === 'Issue') {
    const issue = repo.issues.get(number);
    return issue ? issueObject(repo, issue) : null;
  }
  if (decoded.kind === 'PullRequest') {
    const pull = repo.pulls.get(number);
    return pull ? pullObject(repo, pull) : null;
  }
  if (decoded.kind === 'Comment') {
    for (const comments of repo.comments.values()) {
      const comment = comments.find((candidate) => candidate.id === number);
      if (comment) return { __type: 'Comment', repo, comment };
    }
    return null;
  }
  return null;
}

function repoFromGlobalId(store: Store, id: unknown): Repo {
  if (typeof id !== 'string') throw new Error('repositoryId must be a string');
  const decoded = decodeGlobalId(id);
  if (decoded === null || decoded.kind !== 'Repository') throw new Error(`Unknown repository id ${id}`);
  const slash = decoded.key.indexOf('/');
  const repo = slash >= 0 ? store.getRepo(decoded.key.slice(0, slash), decoded.key.slice(slash + 1)) : undefined;
  if (!repo) throw new Error(`Repository not found: ${decoded.key}`);
  return repo;
}

function splitRef(value: string): string {
  const colon = value.indexOf(':');
  return colon >= 0 ? value.slice(colon + 1) : value;
}

resolvers.Query = {
  viewer: () => userObject(VIEWER.login),
  repository: (_parent, args, ctx) => {
    const repo = ctx.store.getRepo(String(args.owner ?? ''), String(args.name ?? ''));
    return repo ? repoObject(repo) : null;
  },
  node: (_parent, args, ctx) => resolveNode(ctx.store, args.id),
  __type: (_parent, args) => {
    const name = String(args.name ?? '');
    const fields = TYPE_FIELDS[name];
    const enumValues = TYPE_ENUM_VALUES[name];
    if (fields === undefined && enumValues === undefined) return null;
    return { __type: '__Type', name, fields: fields ?? [], enumValues: enumValues ?? null };
  },
};

resolvers.User = {
  login: (parent) => field(parent, 'login'),
  id: (parent) => `User:${String(field(parent, 'login'))}`,
  name: (parent) => field(parent, 'name'),
  email: (parent) => field(parent, 'email'),
};

resolvers.Repository = {
  id: (parent) => repoGlobalId(parent.repo as Repo),
  databaseId: (parent) => (parent.repo as Repo).id,
  name: (parent) => (parent.repo as Repo).name,
  nameWithOwner: (parent) => {
    const repo = parent.repo as Repo;
    return `${repo.owner}/${repo.name}`;
  },
  owner: (parent) => userObject((parent.repo as Repo).owner),
  defaultBranchRef: (parent) => {
    const repo = parent.repo as Repo;
    return branchTip(repo, repo.defaultBranch) !== undefined
      ? { __type: 'Ref', name: repo.defaultBranch }
      : null;
  },
  viewerPermission: () => 'ADMIN',
  hasIssuesEnabled: () => true,
  issue: (parent, args) => {
    const repo = parent.repo as Repo;
    const issue = repo.issues.get(Number(args.number));
    return issue ? issueObject(repo, issue) : null;
  },
  issues: (parent, args) => makeIssueConnection(parent.repo as Repo, args),
  pullRequest: (parent, args) => {
    const repo = parent.repo as Repo;
    const pull = repo.pulls.get(Number(args.number));
    return pull ? pullObject(repo, pull) : null;
  },
  pullRequests: (parent, args) => makePullConnection(parent.repo as Repo, args),
};

resolvers.Ref = {
  name: (parent) => field(parent, 'name'),
};

resolvers.Issue = {
  id: (parent) => issueGlobalId(parent.repo as Repo, parent.issue as Issue),
  databaseId: (parent) => (parent.issue as Issue).id,
  number: (parent) => (parent.issue as Issue).number,
  title: (parent) => (parent.issue as Issue).title,
  body: (parent) => (parent.issue as Issue).body,
  state: (parent) => ((parent.issue as Issue).state === 'open' ? 'OPEN' : 'CLOSED'),
  author: () => userObject(VIEWER.login),
};

resolvers.PullRequest = {
  id: (parent) => pullGlobalId(parent.repo as Repo, parent.pull as Pull),
  databaseId: (parent) => (parent.pull as Pull).id,
  number: (parent) => (parent.pull as Pull).number,
  title: (parent) => (parent.pull as Pull).title,
  body: (parent) => (parent.pull as Pull).body,
  state: (parent) => pullState(parent.pull as Pull),
  headRefName: (parent) => (parent.pull as Pull).headRef,
  baseRefName: (parent) => (parent.pull as Pull).baseRef,
  mergeable: (parent) => {
    const repo = parent.repo as Repo;
    const pull = parent.pull as Pull;
    const headSha = branchTip(repo, pull.headRef) ?? pull.headSha;
    const baseSha = branchTip(repo, pull.baseRef) ?? pull.baseSha;
    if (headSha === undefined || baseSha === undefined) return 'UNKNOWN';
    const base = mergeBase(repo, baseSha, headSha);
    return mergeConflicts(repo, base, baseSha, headSha) ? 'CONFLICTING' : 'MERGEABLE';
  },
  merged: (parent) => (parent.pull as Pull).merged,
  author: () => userObject(VIEWER.login),
  files: (parent, args) => {
    const repo = parent.repo as Repo;
    const pull = parent.pull as Pull;
    const headSha = branchTip(repo, pull.headRef) ?? pull.headSha;
    const baseSha = branchTip(repo, pull.baseRef) ?? pull.baseSha;
    const base = mergeBase(repo, baseSha, headSha);
    const changes = diffFiles(repo, commitFiles(repo, base), commitFiles(repo, headSha));
    const items = changes.map((change) => ({ path: change.path }));
    const first = typeof args.first === 'number' ? args.first : undefined;
    const after = typeof args.after === 'string' ? args.after : undefined;
    const page = paginate(items, first, after, (item) => item.path);
    return { __type: 'PullRequestChangedFileConnection', repo, items, page, first, after };
  },
};

resolvers.IssueConnection = connectionFields('Issue');
resolvers.PullRequestConnection = connectionFields('PullRequest');
resolvers.PullRequestChangedFileConnection = connectionFields('File');

resolvers.PageInfo = {
  hasNextPage: (parent) => field(parent, 'hasNextPage'),
  hasPreviousPage: (parent) => field(parent, 'hasPreviousPage'),
  startCursor: (parent) => field(parent, 'startCursor'),
  endCursor: (parent) => field(parent, 'endCursor'),
};

resolvers.IssueEdge = {
  node: (parent) => field(parent, 'node'),
  cursor: (parent) => field(parent, 'cursor'),
};
resolvers.PullRequestEdge = resolvers.IssueEdge;
resolvers.FileEdge = resolvers.IssueEdge;

resolvers.PullRequestChangedFile = {
  path: (parent) => field(parent, 'path'),
};

resolvers.Comment = {
  id: (parent) => commentGlobalId(parent.repo as Repo, parent.comment as { id: number; body: string }),
  databaseId: (parent) => (parent.comment as { id: number }).id,
  body: (parent) => (parent.comment as { body: string }).body,
  author: () => userObject(VIEWER.login),
};

resolvers.CommentEdge = {
  node: (parent) => field(parent, 'node'),
  cursor: (parent) => field(parent, 'cursor') ?? null,
};

resolvers.__Type = {
  name: (parent) => field(parent, 'name'),
  kind: (parent) => (field(parent, 'enumValues') !== null ? 'ENUM' : 'OBJECT'),
  fields: (parent) => ((parent.fields as string[]) ?? []).map((name) => ({ __type: '__Field', name })),
  enumValues: (parent) => {
    const values = parent.enumValues as string[] | null;
    return values === null ? null : values.map((name) => ({ __type: '__EnumValue', name }));
  },
};

resolvers.__Field = {
  name: (parent) => field(parent, 'name'),
  description: () => null,
};

resolvers.__EnumValue = {
  name: (parent) => field(parent, 'name'),
  description: () => null,
};

resolvers.CreateIssuePayload = {
  issue: (parent) => field(parent, 'issue'),
  clientMutationId: () => null,
};
resolvers.CloseIssuePayload = resolvers.CreateIssuePayload;
resolvers.CreatePullRequestPayload = {
  pullRequest: (parent) => field(parent, 'pullRequest'),
  clientMutationId: () => null,
};
resolvers.MergePullRequestPayload = resolvers.CreatePullRequestPayload;
resolvers.AddCommentPayload = {
  commentEdge: (parent) => field(parent, 'commentEdge'),
  clientMutationId: () => null,
};

function inputObject(args: Record<string, unknown>): Record<string, unknown> {
  const input = args.input;
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('input must be an object');
  }
  return input as Record<string, unknown>;
}

resolvers.Mutation = {
  createIssue: (_parent, args, ctx) => {
    const input = inputObject(args);
    const repo = repoFromGlobalId(ctx.store, input.repositoryId);
    const title = input.title;
    if (typeof title !== 'string' || title === '') throw new Error('title is required');
    const issue = ctx.store.createIssue(repo, title, typeof input.body === 'string' ? input.body : '', []);
    return { __type: 'CreateIssuePayload', issue: issueObject(repo, issue) };
  },
  closeIssue: (_parent, args, ctx) => {
    const input = inputObject(args);
    const node = resolveNode(ctx.store, input.issueId);
    if (node === null || node.__type !== 'Issue') throw new Error('issue not found');
    (node.issue as Issue).state = 'closed';
    return { __type: 'CloseIssuePayload', issue: node };
  },
  createPullRequest: (_parent, args, ctx) => {
    const input = inputObject(args);
    const repo = repoFromGlobalId(ctx.store, input.repositoryId);
    const headRef = splitRef(String(input.headRefName ?? ''));
    const baseRef = splitRef(String(input.baseRefName ?? repo.defaultBranch));
    const headSha = branchTip(repo, headRef);
    const baseSha = branchTip(repo, baseRef);
    if (headSha === undefined) throw new Error(`head branch ${headRef} not found`);
    if (baseSha === undefined) throw new Error(`base branch ${baseRef} not found`);
    const title = input.title;
    if (typeof title !== 'string' || title === '') throw new Error('title is required');
    const pull = ctx.store.createPull(
      repo,
      title,
      typeof input.body === 'string' ? input.body : '',
      headRef,
      baseRef,
      headSha,
      baseSha,
    );
    return { __type: 'CreatePullRequestPayload', pullRequest: pullObject(repo, pull) };
  },
  mergePullRequest: (_parent, args, ctx) => {
    const input = inputObject(args);
    const node = resolveNode(ctx.store, input.pullRequestId);
    if (node === null || node.__type !== 'PullRequest') throw new Error('pull request not found');
    const repo = node.repo as Repo;
    const pull = node.pull as Pull;
    if (pull.state !== 'open') throw new Error('pull request is not open');
    const headSha = branchTip(repo, pull.headRef) ?? pull.headSha;
    const baseSha = branchTip(repo, pull.baseRef) ?? pull.baseSha;
    const base = mergeBase(repo, baseSha, headSha);
    if (mergeConflicts(repo, base, baseSha, headSha)) throw new Error('merge conflict');
    const mergeSha = squashMerge(repo, pull.baseRef, headSha, `Merge pull request #${pull.number} from ${pull.headRef}`);
    if (mergeSha === null) throw new Error('merge conflict');
    pull.state = 'closed';
    pull.merged = true;
    pull.mergedAt = '2023-11-14T22:13:20Z';
    pull.mergeCommitSha = mergeSha;
    return { __type: 'MergePullRequestPayload', pullRequest: node };
  },
  addComment: (_parent, args, ctx) => {
    const input = inputObject(args);
    const node = resolveNode(ctx.store, input.subjectId);
    if (node === null || (node.__type !== 'Issue' && node.__type !== 'PullRequest')) {
      throw new Error('subject not found');
    }
    const repo = node.repo as Repo;
    const number = node.__type === 'Issue' ? (node.issue as Issue).number : (node.pull as Pull).number;
    const body = input.body;
    if (typeof body !== 'string') throw new Error('body is required');
    const comment = ctx.store.createComment(repo, number, body);
    return {
      __type: 'AddCommentPayload',
      commentEdge: {
        __type: 'CommentEdge',
        node: { __type: 'Comment', repo, comment },
        cursor: cursorFor(String(comment.id)),
      },
    };
  },
};

const NODE_TYPES = new Set(['Repository', 'Issue', 'PullRequest', 'Comment']);

function typeMatches(actual: string, condition: string): boolean {
  if (actual === condition) return true;
  if (condition === 'Node' && NODE_TYPES.has(actual)) return true;
  return false;
}

function resolveField(typeName: string, parent: GqlObject, fieldNode: FieldNode, ctx: ExecCtx): unknown {
  if (fieldNode.name === '__typename') return parent.__type;
  const typeResolvers = resolvers[typeName];
  const resolver = typeResolvers?.[fieldNode.name];
  if (resolver === undefined) {
    ctx.errors.push({ message: `Cannot query field "${fieldNode.name}" on type "${typeName}".` });
    return MISSING;
  }
  const args: Record<string, unknown> = {};
  for (const [name, valueNode] of Object.entries(fieldNode.arguments)) {
    args[name] = evalValue(valueNode, ctx.variables);
  }
  try {
    return resolver(parent, args, ctx);
  } catch (err) {
    ctx.errors.push({ message: (err as Error).message });
    return null;
  }
}

function executeSelectionSet(typeName: string, value: GqlObject, selections: Selection[], ctx: ExecCtx): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const selection of selections) {
    if (selection.kind === 'field') {
      const responseKey = selection.alias ?? selection.name;
      const resolved = resolveField(typeName, value, selection, ctx);
      if (resolved === MISSING) continue;
      if (selection.selectionSet === undefined) {
        result[responseKey] = resolved;
        continue;
      }
      if (resolved === null || resolved === undefined) {
        result[responseKey] = null;
        continue;
      }
      if (Array.isArray(resolved)) {
        result[responseKey] = resolved.map((item) => {
          if (item === null || item === undefined) return null;
          const object = item as GqlObject;
          return executeSelectionSet(object.__type, object, selection.selectionSet!, ctx);
        });
        continue;
      }
      const object = resolved as GqlObject;
      result[responseKey] = executeSelectionSet(object.__type, object, selection.selectionSet, ctx);
      continue;
    }
    if (selection.kind === 'spread') {
      const fragment = ctx.fragments.get(selection.name);
      if (fragment === undefined) {
        ctx.errors.push({ message: `Unknown fragment "${selection.name}".` });
        continue;
      }
      if (!typeMatches(value.__type, fragment.typeCondition)) continue;
      Object.assign(result, executeSelectionSet(typeName, value, fragment.selectionSet, ctx));
      continue;
    }
    // Inline fragment.
    if (selection.typeCondition !== undefined && !typeMatches(value.__type, selection.typeCondition)) continue;
    Object.assign(result, executeSelectionSet(typeName, value, selection.selectionSet, ctx));
  }
  return result;
}

function executeOne(request: unknown, store: Store): Record<string, unknown> {
  if (request === null || typeof request !== 'object' || Array.isArray(request)) {
    return { errors: [{ message: 'GraphQL request must be an object' }] };
  }
  const body = request as Record<string, unknown>;
  const query = body.query;
  if (typeof query !== 'string') {
    return { errors: [{ message: 'query must be a string' }] };
  }
  let parsed: { operations: OperationDef[]; fragments: Map<string, FragmentDef> };
  try {
    parsed = new Parser(tokenize(query)).parseDocument();
  } catch (err) {
    return { errors: [{ message: (err as Error).message }] };
  }
  const variables = (body.variables !== null && typeof body.variables === 'object' && !Array.isArray(body.variables))
    ? { ...(body.variables as Record<string, unknown>) }
    : {};
  const operationName = typeof body.operationName === 'string' ? body.operationName : undefined;
  let operation: OperationDef | undefined;
  if (operationName !== undefined) {
    operation = parsed.operations.find((candidate) => candidate.name === operationName);
  } else if (parsed.operations.length === 1) {
    operation = parsed.operations[0];
  }
  if (operation === undefined) {
    return { errors: [{ message: 'Must provide an operation name when there are multiple operations' }] };
  }
  for (const varDef of operation.variableDefinitions) {
    if (variables[varDef.name] === undefined && varDef.defaultValue !== undefined) {
      variables[varDef.name] = evalValue(varDef.defaultValue, variables);
    }
  }
  const ctx: ExecCtx = { store, variables, fragments: parsed.fragments, errors: [] };
  const rootType = operation.operation === 'mutation' ? 'Mutation' : 'Query';
  const root: GqlObject = { __type: rootType };
  const data = executeSelectionSet(rootType, root, operation.selectionSet, ctx);
  const response: Record<string, unknown> = { data };
  if (ctx.errors.length > 0) response.errors = ctx.errors;
  return response;
}

/** Handle POST /api/graphql (single document or a batch array). */
export function handleGraphQL(ctx: ReqCtx): Resp | null {
  if (ctx.pathname !== '/api/graphql') return null;
  if (ctx.method !== 'POST') return json(404, { message: 'Not Found' });
  if (Array.isArray(ctx.body)) {
    return json(200, ctx.body.map((request) => executeOne(request, ctx.store)));
  }
  return json(200, executeOne(ctx.body, ctx.store));
}

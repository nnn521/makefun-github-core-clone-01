// Git smart HTTP: info/refs advertisements (upload-pack v2 and v0, receive-pack v0),
// v2 ls-refs and fetch, v0 fetch, and receive-pack (push). All object ids are SHA-1;
// packs carry plain objects (no deltas), which the suite accepts.

import { DEFAULT_BRANCH, ZERO_OID } from './config.ts';
import {
  collectReachable,
  decodePktLines,
  encodePktLine,
  encodePktLines,
  hashObject,
  isObjectId,
  parseCommit,
  parseTag,
  parseTree,
  pktLineFlush,
  readPack,
  writePack,
  type GitObject,
  type GitPacket,
} from './gitobj.ts';
import { isAncestor, peelTag, peelToCommit, type Repo } from './store.ts';

const UPLOAD_AD = 'application/x-git-upload-pack-advertisement';
const UPLOAD_RESULT = 'application/x-git-upload-pack-result';
const RECEIVE_AD = 'application/x-git-receive-pack-advertisement';
const RECEIVE_RESULT = 'application/x-git-receive-pack-result';

/** Sorted ref names of a repo (refs/heads/* and refs/tags/*). */
export function sortedRefs(repo: Repo): Array<{ name: string; oid: string }> {
  const refs: Array<{ name: string; oid: string }> = [];
  for (const [name, oid] of repo.refs) refs.push({ name, oid });
  refs.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return refs;
}

/** The v2 capability advertisement (identical for every repo: no refs are listed). */
const V2_ADVERTISEMENT = encodePktLines([
  'version 2\n',
  'ls-refs\n',
  'fetch=shallow\n',
  'object-format=sha1\n',
  'flush',
]);

/**
 * A v0 ref advertisement: the service preamble, then `<oid> <ref>` lines, the first
 * carrying the capabilities after a NUL. Annotated tags get a peeled `^{}` line.
 */
function v0Advertisement(service: 'git-upload-pack' | 'git-receive-pack', repo: Repo, capabilities: string[]): Buffer {
  const lines: Array<string | 'flush'> = [`# service=${service}\n`, 'flush'];
  const refs = sortedRefs(repo);
  const caps = capabilities.join(' ');
  if (refs.length === 0) {
    lines.push(`${ZERO_OID} capabilities^{}\0${caps}\n`);
  } else {
    const headOid = repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? refs[0]!.oid;
    lines.push(`${headOid} HEAD\0${caps}\n`);
    for (const ref of refs) {
      lines.push(`${ref.oid} ${ref.name}\n`);
      const peeled = peelTag(repo, ref.oid);
      if (peeled !== undefined) lines.push(`${peeled} ${ref.name}^{}\n`);
    }
  }
  lines.push('flush');
  return encodePktLines(lines);
}

const UPLOAD_V0_CAPS = ['side-band-64k', 'multi_ack', 'thin-pack', 'ofs-delta', 'shallow', `symref=HEAD:refs/heads/${DEFAULT_BRANCH}`];
const RECEIVE_V0_CAPS = ['report-status', 'side-band-64k', 'delete-refs', 'ofs-delta'];

/** GET /{owner}/{repo}.git/info/refs?service=... */
export function handleInfoRefs(
  repo: Repo | undefined,
  service: string,
  gitProtocolVersion2: boolean,
): { status: number; contentType: string; body: Buffer } {
  if (repo === undefined) {
    return { status: 404, contentType: 'application/json', body: Buffer.from(JSON.stringify({ message: 'Not Found' })) };
  }
  if (service === 'git-upload-pack') {
    if (gitProtocolVersion2) {
      return { status: 200, contentType: UPLOAD_AD, body: V2_ADVERTISEMENT };
    }
    return { status: 200, contentType: UPLOAD_AD, body: v0Advertisement('git-upload-pack', repo, UPLOAD_V0_CAPS) };
  }
  if (service === 'git-receive-pack') {
    return { status: 200, contentType: RECEIVE_AD, body: v0Advertisement('git-receive-pack', repo, RECEIVE_V0_CAPS) };
  }
  return { status: 404, contentType: 'application/json', body: Buffer.from(JSON.stringify({ message: 'Not Found' })) };
}

// ---------------------------------------------------------------------------------------------
// ls-refs (v2)
// ---------------------------------------------------------------------------------------------

function lsRefsResponse(repo: Repo, args: { prefixes: string[]; peel: boolean; symrefs: boolean }): Buffer {
  const refs = sortedRefs(repo);
  const lines: Array<string | 'flush'> = [];
  const keep = (name: string): boolean => args.prefixes.length === 0 || args.prefixes.some((prefix) => name.startsWith(prefix));
  const headOid = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  if (headOid !== undefined && keep('HEAD')) {
    const symref = args.symrefs ? ` symref-target:refs/heads/${repo.defaultBranch}` : '';
    lines.push(`${headOid} HEAD${symref}\n`);
  }
  for (const ref of refs) {
    if (!keep(ref.name)) continue;
    let line = `${ref.oid} ${ref.name}`;
    if (args.peel) {
      const peeled = peelTag(repo, ref.oid);
      if (peeled !== undefined) line += ` peeled:${peeled}`;
    }
    lines.push(`${line}\n`);
  }
  lines.push('flush');
  return encodePktLines(lines);
}

// ---------------------------------------------------------------------------------------------
// fetch
// ---------------------------------------------------------------------------------------------

interface FetchArgs {
  wants: string[];
  haves: string[];
  shallow: string[];
  depth: number | null;
}

/** Parse a v2 fetch command's argument lines. */
function parseFetchArgs(lines: string[]): FetchArgs {
  const args: FetchArgs = { wants: [], haves: [], shallow: [], depth: null };
  for (const line of lines) {
    const text = line.replace(/\n$/, '');
    if (text.startsWith('want ')) args.wants.push(text.slice(5).trim());
    else if (text.startsWith('have ')) args.haves.push(text.slice(5).trim());
    else if (text.startsWith('shallow ')) args.shallow.push(text.slice(8).trim());
    else if (text.startsWith('deepen ')) {
      const depth = Number.parseInt(text.slice(7).trim(), 10);
      if (Number.isFinite(depth) && depth > 0) args.depth = depth;
    }
  }
  return args;
}

/**
 * The commits included by a fetch: BFS from the wants, cut at `depth` generations
 * (want = generation 1). Returns the included commits and the new shallow boundary
 * (commits at exactly the depth limit, or roots).
 */
function fetchCommitSet(
  repo: Repo,
  wants: readonly string[],
  depth: number | null,
): { included: Set<string>; boundary: Set<string> } {
  const included = new Set<string>();
  const boundary = new Set<string>();
  const queue: Array<{ oid: string; generation: number }> = [];
  for (const want of wants) {
    const commit = peelToCommit(repo, want);
    if (commit !== undefined) queue.push({ oid: commit, generation: 1 });
  }
  while (queue.length) {
    const { oid, generation } = queue.shift()!;
    if (included.has(oid)) continue;
    const object = repo.objects.get(oid);
    if (!object || object.type !== 'commit') continue;
    included.add(oid);
    const parents = parseCommit(object.data).parents;
    if (depth !== null && generation >= depth) {
      boundary.add(oid);
      continue;
    }
    if (parents.length === 0) boundary.add(oid);
    for (const parent of parents) queue.push({ oid: parent, generation: generation + 1 });
  }
  return { included, boundary };
}

/**
 * The objects a fetch sends: the closure of the included commits (commit + tree + blobs),
 * minus what the client already holds. The client's held set is the closure of its haves,
 * cut at its own shallow boundaries (a shallow commit's parents are not held).
 */
function fetchObjects(repo: Repo, args: FetchArgs): { objects: GitObject[]; shallow: string[]; unshallow: string[] } {
  const { included, boundary } = fetchCommitSet(repo, args.wants, args.depth);
  // The full object closure of the included commits.
  const wanted = new Set<string>();
  for (const oid of included) {
    wanted.add(oid);
    const object = repo.objects.get(oid);
    if (!object || object.type !== 'commit') continue;
    for (const reachable of collectReachable([parseCommit(object.data).tree], (id) => repo.objects.get(id), { allowMissing: true })) {
      wanted.add(reachable);
    }
  }
  // What the client already has: closure of haves, not traversing past its shallow lines.
  const held = new Set<string>();
  const clientShallow = new Set(args.shallow);
  const queue: string[] = [...args.haves];
  while (queue.length) {
    const oid = queue.pop()!;
    if (held.has(oid)) continue;
    const object = repo.objects.get(oid);
    if (!object) continue;
    held.add(oid);
    if (object.type === 'commit') {
      if (clientShallow.has(oid)) {
        // The client holds this commit and its tree, but not its parents.
        for (const reachable of collectReachable([parseCommit(object.data).tree], (id) => repo.objects.get(id), { allowMissing: true })) {
          held.add(reachable);
        }
        continue;
      }
      queue.push(parseCommit(object.data).tree);
      for (const parent of parseCommit(object.data).parents) queue.push(parent);
    } else if (object.type === 'tag') {
      queue.push(parseTag(object.data).object);
    } else if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) {
        if (entry.mode !== '160000') queue.push(entry.oid);
      }
    }
  }
  const objects: GitObject[] = [];
  // Emit commits first (BFS order from the wants), then trees and blobs: a stable order.
  const commitOrder: string[] = [];
  const seenCommit = new Set<string>();
  const bfs: string[] = [];
  for (const want of args.wants) {
    const commit = peelToCommit(repo, want);
    if (commit !== undefined && included.has(commit)) bfs.push(commit);
  }
  while (bfs.length) {
    const oid = bfs.shift()!;
    if (seenCommit.has(oid) || !included.has(oid)) continue;
    seenCommit.add(oid);
    commitOrder.push(oid);
    const object = repo.objects.get(oid);
    if (object?.type === 'commit') for (const parent of parseCommit(object.data).parents) bfs.push(parent);
  }
  const emitted = new Set<string>();
  const emit = (oid: string): void => {
    if (emitted.has(oid) || held.has(oid) || !wanted.has(oid)) return;
    const object = repo.objects.get(oid);
    if (!object) return;
    emitted.add(oid);
    objects.push(object);
  };
  for (const oid of commitOrder) emit(oid);
  for (const oid of wanted) {
    const object = repo.objects.get(oid);
    if (object?.type === 'tree') emit(oid);
  }
  for (const oid of wanted) {
    const object = repo.objects.get(oid);
    if (object?.type === 'blob') emit(oid);
  }
  // Tags the wants name directly are included as well.
  for (const want of args.wants) {
    const object = repo.objects.get(want);
    if (object?.type === 'tag' && !held.has(want) && !emitted.has(want)) {
      emitted.add(want);
      objects.push(object);
    }
  }
  // shallow-info: the new boundary only exists when a depth was requested; an old
  // client shallow line is unshallowed when its commit is now interior (a parent
  // included) — with a full fetch every non-root shallow commit qualifies.
  const shallow = args.depth !== null ? [...boundary].filter((oid) => included.has(oid)).sort() : [];
  const unshallow = args.shallow.filter((oid) => included.has(oid) && !boundary.has(oid)).sort();
  return { objects, shallow, unshallow };
}

/** Chunk bytes into sideband band-1 pkt-lines (band byte + at most 65515 data bytes). */
function sidebandPackets(band: 1 | 2, data: Buffer): Buffer[] {
  const out: Buffer[] = [];
  const CHUNK = 65515;
  if (data.length === 0) {
    out.push(encodePktLine(Buffer.concat([Buffer.from([band])])));
    return out;
  }
  for (let offset = 0; offset < data.length; offset += CHUNK) {
    const slice = data.subarray(offset, Math.min(offset + CHUNK, data.length));
    out.push(encodePktLine(Buffer.concat([Buffer.from([band]), slice])));
  }
  return out;
}

/** Build the v2 fetch response for parsed args. */
function fetchV2Response(repo: Repo, args: FetchArgs): Buffer {
  const { objects, shallow, unshallow } = fetchObjects(repo, args);
  const pack = writePack(objects);
  const parts: Buffer[] = [];
  // acknowledgments
  const knownHaves = args.haves.filter((oid) => repo.objects.has(oid));
  parts.push(encodePktLine('acknowledgments\n'));
  if (knownHaves.length > 0) {
    for (const oid of knownHaves) parts.push(encodePktLine(`ACK ${oid}\n`));
    parts.push(encodePktLine('ready\n'));
  } else {
    parts.push(encodePktLine('NAK\n'));
  }
  parts.push(pktLineFlush());
  // shallow-info (only when there is something to say)
  if (args.depth !== null || shallow.length > 0 || unshallow.length > 0) {
    parts.push(encodePktLine('shallow-info\n'));
    for (const oid of shallow) parts.push(encodePktLine(`shallow ${oid}\n`));
    for (const oid of unshallow) parts.push(encodePktLine(`unshallow ${oid}\n`));
    parts.push(pktLineFlush());
  }
  // packfile
  parts.push(encodePktLine('packfile\n'));
  for (const packet of sidebandPackets(1, pack)) parts.push(packet);
  parts.push(pktLineFlush());
  return Buffer.concat(parts);
}

/** Build the v0 fetch response (NAK/ACK + shallow lines + sideband pack). */
function fetchV0Response(repo: Repo, args: FetchArgs): Buffer {
  const { objects, shallow, unshallow } = fetchObjects(repo, args);
  const pack = writePack(objects);
  const parts: Buffer[] = [];
  const knownHaves = args.haves.filter((oid) => repo.objects.has(oid));
  if (knownHaves.length > 0) {
    for (const oid of knownHaves) parts.push(encodePktLine(`ACK ${oid}\n`));
  } else {
    parts.push(encodePktLine('NAK\n'));
  }
  for (const oid of shallow) parts.push(encodePktLine(`shallow ${oid}\n`));
  for (const oid of unshallow) parts.push(encodePktLine(`unshallow ${oid}\n`));
  for (const packet of sidebandPackets(1, pack)) parts.push(packet);
  parts.push(pktLineFlush());
  return Buffer.concat(parts);
}

/** Parse a v0 fetch request body (want/have/shallow/deepen lines in two sections). */
function parseV0Fetch(lines: string[]): FetchArgs {
  return parseFetchArgs(lines);
}

// ---------------------------------------------------------------------------------------------
// upload-pack POST
// ---------------------------------------------------------------------------------------------

/** POST /{owner}/{repo}.git/git-upload-pack */
export function handleUploadPack(
  repo: Repo | undefined,
  body: Buffer,
): { status: number; contentType: string; body: Buffer } {
  if (repo === undefined) {
    return { status: 404, contentType: 'application/json', body: Buffer.from(JSON.stringify({ message: 'Not Found' })) };
  }
  let packets: GitPacket[];
  try {
    packets = decodePktLines(body).packets;
  } catch {
    return { status: 400, contentType: 'application/json', body: Buffer.from(JSON.stringify({ message: 'malformed pkt-line stream' })) };
  }
  const lines = packets.filter((p): p is Extract<GitPacket, { kind: 'data' }> => p.kind === 'data').map((p) => p.payload.toString('utf8'));
  const first = lines[0]?.replace(/\n$/, '') ?? '';
  try {
    if (first.startsWith('command=')) {
      const command = first.slice('command='.length);
      if (command === 'ls-refs') {
        const prefixes: string[] = [];
        let peel = false;
        let symrefs = false;
        for (const line of lines.slice(1)) {
          const text = line.replace(/\n$/, '');
          if (text.startsWith('ref-prefix ')) prefixes.push(text.slice('ref-prefix '.length));
          else if (text === 'peel') peel = true;
          else if (text === 'symrefs') symrefs = true;
        }
        return { status: 200, contentType: UPLOAD_RESULT, body: lsRefsResponse(repo, { prefixes, peel, symrefs }) };
      }
      if (command === 'fetch') {
        const args = parseFetchArgs(lines.slice(1));
        return { status: 200, contentType: UPLOAD_RESULT, body: fetchV2Response(repo, args) };
      }
      return { status: 400, contentType: 'application/json', body: Buffer.from(JSON.stringify({ message: `unknown command ${command}` })) };
    }
    if (first.startsWith('want ')) {
      const args = parseV0Fetch(lines);
      return { status: 200, contentType: UPLOAD_RESULT, body: fetchV0Response(repo, args) };
    }
    return { status: 400, contentType: 'application/json', body: Buffer.from(JSON.stringify({ message: 'unrecognized upload-pack request' })) };
  } catch (err) {
    return { status: 400, contentType: 'application/json', body: Buffer.from(JSON.stringify({ message: (err as Error).message })) };
  }
}

// ---------------------------------------------------------------------------------------------
// receive-pack POST (push)
// ---------------------------------------------------------------------------------------------

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

/** POST /{owner}/{repo}.git/git-receive-pack */
export function handleReceivePack(
  repo: Repo | undefined,
  body: Buffer,
): { status: number; contentType: string; body: Buffer } {
  if (repo === undefined) {
    return { status: 404, contentType: 'application/json', body: Buffer.from(JSON.stringify({ message: 'Not Found' })) };
  }
  let packets: GitPacket[];
  let rest: Buffer;
  try {
    const decoded = decodePktLines(body, { allowTrailing: true });
    packets = decoded.packets;
    rest = decoded.rest;
  } catch {
    return { status: 400, contentType: 'application/json', body: Buffer.from(JSON.stringify({ message: 'malformed pkt-line stream' })) };
  }
  const commands: PushCommand[] = [];
  let sideband = false;
  let first = true;
  for (const packet of packets) {
    if (packet.kind !== 'data') continue;
    const text = packet.payload.toString('utf8').replace(/\n$/, '');
    let line = text;
    if (first) {
      first = false;
      const nul = line.indexOf('\0');
      if (nul >= 0) {
        const caps = line.slice(nul + 1).split(' ');
        sideband = caps.includes('side-band-64k');
        line = line.slice(0, nul);
      }
    }
    const match = /^([0-9a-f]{40}) ([0-9a-f]{40}) (refs\/\S+)$/.exec(line);
    if (!match) {
      return { status: 400, contentType: 'application/json', body: Buffer.from(JSON.stringify({ message: `bad push command ${JSON.stringify(line.slice(0, 80))}` })) };
    }
    commands.push({ oldOid: match[1]!, newOid: match[2]!, ref: match[3]! });
  }
  if (commands.length === 0) {
    return { status: 400, contentType: 'application/json', body: Buffer.from(JSON.stringify({ message: 'push needs at least one command' })) };
  }
  // Unpack the pack (even for refused updates, `unpack ok` is still owed).
  let unpackOk = true;
  let unpackDetail = 'ok';
  const needsPack = commands.some((command) => command.newOid !== ZERO_OID);
  if (needsPack) {
    if (rest.length === 0) {
      unpackOk = false;
      unpackDetail = 'missing pack';
    } else {
      try {
        const objects = readPack(rest, { resolveBase: (oid) => repo.objects.get(oid) });
        for (const [oid, object] of objects) {
          if (!repo.objects.has(oid)) repo.objects.set(oid, object);
        }
      } catch (err) {
        unpackOk = false;
        unpackDetail = (err as Error).message;
      }
    }
  } else if (rest.length > 0) {
    // A delete-only push carries no pack; stray bytes are ignored.
  }
  // Apply the ref updates, one report line per command, in order.
  const reportLines: Array<string | 'flush'> = [`unpack ${unpackOk ? 'ok' : `error ${unpackDetail}`}\n`];
  for (const command of commands) {
    if (!unpackOk) {
      reportLines.push(`ng ${command.ref} unpacker error\n`);
      continue;
    }
    const current = repo.refs.get(command.ref);
    if (command.newOid === ZERO_OID) {
      // Delete.
      if (current === undefined) {
        reportLines.push(`ng ${command.ref} non-fast-forward\n`);
      } else if (command.oldOid !== ZERO_OID && command.oldOid !== current) {
        reportLines.push(`ng ${command.ref} non-fast-forward\n`);
      } else {
        repo.refs.delete(command.ref);
        reportLines.push(`ok ${command.ref}\n`);
      }
      continue;
    }
    if (!repo.objects.has(command.newOid)) {
      reportLines.push(`ng ${command.ref} missing object\n`);
      continue;
    }
    if (current === undefined) {
      if (command.oldOid !== ZERO_OID) {
        reportLines.push(`ng ${command.ref} non-fast-forward\n`);
      } else {
        repo.refs.set(command.ref, command.newOid);
        reportLines.push(`ok ${command.ref}\n`);
      }
      continue;
    }
    if (command.oldOid !== current) {
      reportLines.push(`ng ${command.ref} non-fast-forward\n`);
      continue;
    }
    if (command.newOid === current) {
      reportLines.push(`ok ${command.ref}\n`);
      continue;
    }
    // Fast-forward: the current tip must be an ancestor of the new tip (tags peel to commits).
    const newCommit = peelToCommit(repo, command.newOid);
    const curCommit = peelToCommit(repo, current);
    if (newCommit !== undefined && curCommit !== undefined && isAncestor(repo, newCommit, curCommit)) {
      repo.refs.set(command.ref, command.newOid);
      reportLines.push(`ok ${command.ref}\n`);
    } else {
      reportLines.push(`ng ${command.ref} non-fast-forward\n`);
    }
  }
  reportLines.push('flush');
  const report = encodePktLines(reportLines);
  if (sideband) {
    const parts: Buffer[] = [];
    for (const packet of sidebandPackets(1, report)) parts.push(packet);
    parts.push(pktLineFlush());
    return { status: 200, contentType: RECEIVE_RESULT, body: Buffer.concat(parts) };
  }
  return { status: 200, contentType: RECEIVE_RESULT, body: report };
}

export { hashObject };

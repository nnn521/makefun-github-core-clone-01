// HTTP server: body reading, auth, routing between the git smart-HTTP handlers,
// the MCP endpoint, GraphQL and REST. Every response carries a deterministic
// request id; every JSON error carries a `message` field.

import http from 'node:http';
import { SHOP_TOKEN } from './config.ts';
import { handleInfoRefs, handleReceivePack, handleUploadPack } from './git.ts';
import { handleGraphQL } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import { handleRest, jsonError, type ReqCtx, type Resp } from './rest.ts';
import { Store } from './store.ts';

const MAX_BODY_BYTES = 64 * 1024 * 1024;

let requestCounter = 0;

function isJsonRoute(pathname: string): boolean {
  return pathname === '/mcp' || pathname.startsWith('/api/');
}

function isPublicRoute(method: string, pathname: string): boolean {
  if (method === 'GET' && pathname === '/healthz') return true;
  if (method === 'GET' && (pathname === '/api/v3' || pathname === '/api/v3/')) return true;
  if (method === 'GET' && pathname === '/api/v3/meta') return true;
  return false;
}

async function readBody(req: http.IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buffer = chunk as Buffer;
    total += buffer.length;
    if (total > MAX_BODY_BYTES) throw new Error('request body too large');
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

function send(res: http.ServerResponse, resp: Resp, requestId: string): void {
  const body = typeof resp.body === 'string' ? Buffer.from(resp.body, 'utf8') : resp.body;
  const headers: Record<string, string> = {
    'X-GitHub-Request-Id': requestId,
    ...(resp.headers ?? {}),
  };
  if (resp.status !== 204) {
    headers['content-length'] = String(body.length);
    if (headers['content-type'] === undefined) headers['content-type'] = 'application/json';
  }
  res.writeHead(resp.status, headers);
  if (resp.status === 204) res.end();
  else res.end(body);
}

const GIT_ROUTE = /^\/([^/]+)\/([^/]+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/;

export function createApp(): { server: http.Server; store: Store } {
  const store = new Store();

  const server = http.createServer((req, res) => {
    void (async () => {
      const requestId = `req-${++requestCounter}`;
      try {
        const url = new URL(req.url ?? '/', 'http://localhost');
        const pathname = url.pathname;
        const method = req.method ?? 'GET';
        // GET/HEAD never carry a body in this suite; skipping the stream read
        // saves a few event-loop turns per request on the hot read path.
        const body = method === 'GET' || method === 'HEAD' ? Buffer.alloc(0) : await readBody(req);
        const bodyText = body.toString('utf8');

        // Auth (before routing, except the public routes).
        if (!isPublicRoute(method, pathname)) {
          const authorization = req.headers.authorization ?? '';
          if (authorization !== `Bearer ${SHOP_TOKEN}`) {
            send(res, jsonError(401, 'Bad credentials'), requestId);
            return;
          }
        }

        // JSON body parsing for the JSON surfaces.
        let parsedBody: unknown = null;
        if (isJsonRoute(pathname) && bodyText.trim() !== '' && method !== 'GET' && method !== 'HEAD') {
          try {
            parsedBody = JSON.parse(bodyText);
          } catch {
            if (pathname === '/mcp') {
              // The MCP handler answers the parse error as JSON-RPC -32700.
              parsedBody = null;
            } else {
              send(res, jsonError(400, 'malformed JSON body'), requestId);
              return;
            }
          }
        }

        const ctx: ReqCtx = {
          method,
          pathname,
          query: url.searchParams,
          body: parsedBody,
          bodyText,
          host: req.headers.host ?? 'localhost',
          store,
        };

        if (method === 'GET' && pathname === '/healthz') {
          send(res, { status: 200, headers: { 'content-type': 'application/json' }, body: '{"ok":true}' }, requestId);
          return;
        }

        const gitMatch = GIT_ROUTE.exec(pathname);
        if (gitMatch !== null) {
          const owner = decodeURIComponent(gitMatch[1]!);
          const repoName = decodeURIComponent(gitMatch[2]!);
          const repo = store.getRepo(owner, repoName);
          const action = gitMatch[3]!;
          if (action === 'info/refs' && method === 'GET') {
            const service = url.searchParams.get('service') ?? '';
            const v2 = (req.headers['git-protocol'] ?? '') === 'version=2';
            const result = handleInfoRefs(repo, service, v2);
            send(res, { status: result.status, headers: { 'content-type': result.contentType }, body: result.body }, requestId);
            return;
          }
          if (action === 'git-upload-pack' && method === 'POST') {
            const result = handleUploadPack(repo, body);
            send(res, { status: result.status, headers: { 'content-type': result.contentType }, body: result.body }, requestId);
            return;
          }
          if (action === 'git-receive-pack' && method === 'POST') {
            const result = handleReceivePack(repo, body);
            send(res, { status: result.status, headers: { 'content-type': result.contentType }, body: result.body }, requestId);
            return;
          }
          send(res, jsonError(404, 'Not Found'), requestId);
          return;
        }

        if (pathname === '/mcp') {
          const result = handleMcp(ctx);
          if (result !== null) {
            send(res, result, requestId);
            return;
          }
        }

        if (pathname === '/api/graphql') {
          const result = handleGraphQL(ctx);
          if (result !== null) {
            send(res, result, requestId);
            return;
          }
        }

        if (pathname.startsWith('/api/v3')) {
          const result = handleRest(ctx);
          if (result !== null) {
            send(res, result, requestId);
            return;
          }
        }

        send(res, jsonError(404, 'Not Found'), requestId);
      } catch (err) {
        // Never let one bad request take the server down.
        try {
          send(res, jsonError(500, (err as Error).message), requestId);
        } catch {
          try {
            res.destroy();
          } catch {
            // Nothing left to do.
          }
        }
      }
    })();
  });

  server.on('error', (err) => {
    console.error('server error:', err);
  });

  return { server, store };
}

// Entrypoint. In a trial, listen on a kernel-chosen port, register it with the
// environment, then poll /done until the run ends. Locally (no MAKEFUN_ENV_URL),
// serve forever on PORT (default 3000) so the sealed suite can be run against it.

import http from 'node:http';
import { createApp } from './app.ts';

const ENV_URL = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/$/, '');
const DEV_PORT = Number.parseInt(process.env.PORT ?? '3000', 10);

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function listenOn(server: http.Server, port: number): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const onError = (err: Error): void => reject(err);
    server.once('error', onError);
    server.listen(port, () => {
      server.removeListener('error', onError);
      const address = server.address();
      if (address === null || typeof address === 'string') {
        reject(new Error('server has no address after listen'));
        return;
      }
      resolve(address.port);
    });
  });
}

async function register(envUrl: string, port: number): Promise<void> {
  let delay = 200;
  for (let attempt = 0; attempt < 12; attempt += 1) {
    try {
      const response = await fetch(`${envUrl}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
      });
      if (response.ok) return;
      if (response.status === 409) {
        throw new Error('register got 409: another process already registered this trial');
      }
      throw new Error(`register got HTTP ${response.status}`);
    } catch (err) {
      if (attempt === 11) throw err;
      if (err instanceof Error && err.message.includes('409')) throw err;
      await sleep(delay);
      delay = Math.min(delay * 2, 2000);
    }
  }
}

async function waitDone(envUrl: string): Promise<void> {
  for (;;) {
    try {
      const response = await fetch(`${envUrl}/done`);
      if (response.ok) {
        const data = (await response.json()) as { done?: unknown };
        if (data.done === true) return;
      }
    } catch {
      // Transient env hiccup: keep polling, never exit early.
    }
    await sleep(500);
  }
}

async function close(server: http.Server): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => resolve());
  });
}

async function main(): Promise<void> {
  const { server } = createApp();

  if (ENV_URL === '') {
    const port = await listenOn(server, Number.isFinite(DEV_PORT) ? DEV_PORT : 3000);
    console.log(`forge listening on http://127.0.0.1:${port} (dev mode, no MAKEFUN_ENV_URL)`);
    return;
  }

  const port = await listenOn(server, 0);
  await register(ENV_URL, port);
  await waitDone(ENV_URL);
  await close(server);
  process.exit(0);
}

process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});

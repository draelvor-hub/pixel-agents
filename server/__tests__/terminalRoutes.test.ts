/**
 * Terminal endpoint auth.
 *
 * `/terminal/:agentId` is arbitrary code execution -- these tests pin the
 * property that it is unreachable without the auth token, from a real WebSocket
 * client against a real server. See docs/design/standalone-terminal.md.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
// Named import: `ws` is CJS, and the server tsconfig's Node16 resolution has no
// allowSyntheticDefaultImports, so the default import form won't typecheck.
// `ws` rather than Node's built-in WebSocket because the foreign-origin test
// must set an Origin header, which the built-in client cannot do.
import { WebSocket } from 'ws';

import {
  TERMINAL_CLOSE_NO_SESSION,
  TERMINAL_CLOSE_UNAUTHORIZED,
  TERMINAL_WS_PROTOCOL,
} from '../../core/src/constants.js';
import type { IPty, PtyModule } from '../src/terminal/ptyModule.js';
import { PtySessionManager } from '../src/terminal/ptySessionManager.js';

let tmpBase: string;

// Isolated HOME: server.start() writes server.json + the registry entry, and a
// test must never touch the developer's real ~/.pixel-agents.
vi.mock('os', async () => {
  const actual = await vi.importActual<typeof import('os')>('os');
  return { ...actual, homedir: () => tmpBase };
});

// Imported after the os mock is registered, so server.ts picks up the temp HOME.
const { PixelAgentsServer } = await import('../src/server.js');
const { AgentStateStore } = await import('../src/agentStateStore.js');

/** Minimal fake PTY -- no real process is ever spawned by these tests. */
class FakePty implements IPty {
  readonly pid = 1;
  private dataListener: ((d: string) => void) | null = null;
  written: string[] = [];
  resizes: Array<{ cols: number; rows: number }> = [];
  onData(l: (d: string) => void): void {
    this.dataListener = l;
  }
  onExit(): void {
    /* never exits in these tests */
  }
  write(d: string): void {
    this.written.push(d);
  }
  resize(cols: number, rows: number): void {
    this.resizes.push({ cols, rows });
  }
  kill(): void {
    /* no-op */
  }
  emit(d: string): void {
    this.dataListener?.(d);
  }
}

let lastPty: FakePty;

function fakeManager(): PtySessionManager {
  const module: PtyModule = {
    spawn: () => {
      lastPty = new FakePty();
      return lastPty;
    },
  };
  return new PtySessionManager(() => ({ module, moduleId: 'fake-pty', reason: null }));
}

interface Attempt {
  code: number;
  opened: boolean;
}

/** Connect and resolve how the server responded (opened, or closed with a code). */
function attach(
  port: number,
  agentId: number,
  protocols?: string[],
  origin?: string,
): Promise<Attempt> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(
      `ws://127.0.0.1:${String(port)}/terminal/${String(agentId)}`,
      protocols,
      origin ? { headers: { origin } } : undefined,
    );
    let opened = false;
    ws.on('open', () => {
      opened = true;
    });
    ws.on('close', (code: number) => resolve({ code, opened }));
    ws.on('error', () => {
      // A close-during-handshake surfaces as an error in ws; the close handler
      // still fires with the code, so let it settle there.
    });
    setTimeout(() => reject(new Error('terminal socket timed out')), 5_000);
  });
}

describe('terminal WebSocket auth', () => {
  let server: InstanceType<typeof PixelAgentsServer>;
  let ptyManager: PtySessionManager;
  let port: number;
  let token: string;

  beforeEach(async () => {
    tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'pxl-terminal-test-'));
    fs.mkdirSync(path.join(tmpBase, '.pixel-agents'), { recursive: true });
    server = new PixelAgentsServer();
    ptyManager = fakeManager();
    const config = await server.start({
      store: new AgentStateStore(),
      embedded: false,
      ptyManager,
    });
    port = config.port;
    token = config.token;
    ptyManager.create({ agentId: 1, command: 'claude', args: [], cwd: tmpBase });
  });

  afterEach(() => {
    ptyManager?.disposeAll();
    server?.stop();
    try {
      fs.rmSync(tmpBase, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it('accepts a connection carrying the valid token', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${String(port)}/terminal/1`, [
      TERMINAL_WS_PROTOCOL,
      token,
    ]);
    await new Promise<void>((resolve, reject) => {
      ws.on('open', () => resolve());
      ws.on('error', reject);
    });
    expect(ws.readyState).toBe(WebSocket.OPEN);
    ws.close();
  });

  it('rejects a connection with no token', async () => {
    // The attack: any web page can open a WebSocket to localhost (WS is exempt
    // from CORS). Without the token this would hand out a shell.
    const result = await attach(port, 1, [TERMINAL_WS_PROTOCOL]);
    expect(result.code).toBe(TERMINAL_CLOSE_UNAUTHORIZED);
  });

  it('rejects a connection with a wrong token', async () => {
    const result = await attach(port, 1, [TERMINAL_WS_PROTOCOL, 'not-the-token']);
    expect(result.code).toBe(TERMINAL_CLOSE_UNAUTHORIZED);
  });

  it('rejects a token of the same length as the real one', async () => {
    const sameLength = 'x'.repeat(token.length);
    const result = await attach(port, 1, [TERMINAL_WS_PROTOCOL, sameLength]);
    expect(result.code).toBe(TERMINAL_CLOSE_UNAUTHORIZED);
  });

  it('rejects a valid token sent from a foreign origin', async () => {
    const result = await attach(port, 1, [TERMINAL_WS_PROTOCOL, token], 'http://evil.com');
    expect(result.code).toBe(TERMINAL_CLOSE_UNAUTHORIZED);
  });

  it('rejects attaching to an agent with no terminal, even with a valid token', async () => {
    // The route can only attach to PTYs this server spawned; it can never start one.
    const result = await attach(port, 999, [TERMINAL_WS_PROTOCOL, token]);
    expect(result.code).toBe(TERMINAL_CLOSE_NO_SESSION);
  });
});

describe('terminal session token endpoint', () => {
  let server: InstanceType<typeof PixelAgentsServer>;
  let ptyManager: PtySessionManager;
  let port: number;
  let token: string;

  beforeEach(async () => {
    tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'pxl-terminal-api-test-'));
    fs.mkdirSync(path.join(tmpBase, '.pixel-agents'), { recursive: true });
    server = new PixelAgentsServer();
    ptyManager = fakeManager();
    const config = await server.start({
      store: new AgentStateStore(),
      embedded: false,
      ptyManager,
    });
    port = config.port;
    token = config.token;
  });

  afterEach(() => {
    ptyManager?.disposeAll();
    server?.stop();
    try {
      fs.rmSync(tmpBase, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it('serves the token to a same-origin request', async () => {
    const res = await fetch(`http://127.0.0.1:${String(port)}/api/terminal/session`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { token: string; available: boolean };
    expect(body.token).toBe(token);
    expect(body.available).toBe(true);
  });

  it('refuses to hand the token to a cross-origin request', async () => {
    // @fastify/cors is registered with origin:true, which reflects any Origin --
    // so without the same-origin guard this endpoint would give evil.com a shell.
    const res = await fetch(`http://127.0.0.1:${String(port)}/api/terminal/session`, {
      headers: { Origin: 'http://evil.com' },
    });
    expect(res.status).toBe(403);
    expect(await res.text()).not.toContain(token);
  });

  it('reports unavailability with a reason instead of a token-bearing success', async () => {
    server.stop();
    const brokenServer = new PixelAgentsServer();
    const brokenManager = new PtySessionManager(() => ({
      module: null,
      moduleId: null,
      reason: 'no PTY module installed',
    }));
    const config = await brokenServer.start({
      store: new AgentStateStore(),
      embedded: false,
      ptyManager: brokenManager,
    });
    try {
      const res = await fetch(`http://127.0.0.1:${String(config.port)}/api/terminal/session`);
      const body = (await res.json()) as { available: boolean; reason?: string };
      expect(body.available).toBe(false);
      expect(body.reason).toBe('no PTY module installed');
    } finally {
      brokenServer.stop();
    }
  });
});

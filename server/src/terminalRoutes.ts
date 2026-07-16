/**
 * Terminal routes: the data plane for the standalone embedded terminal.
 *
 * SECURITY: `/terminal/:agentId` pipes a browser's keystrokes into a real
 * process. It is arbitrary code execution and is the most sensitive surface in
 * this codebase.
 *
 * Note this route authenticates in BOTH modes, unlike `/ws`, which skips auth in
 * standalone on the reasoning that binding to 127.0.0.1 is enough. That
 * reasoning does not hold for a terminal:
 *
 *   - WebSocket connections are exempt from CORS, so any page the user visits
 *     can open ws://127.0.0.1:<port>/terminal/1 -- the same-origin policy stops
 *     the browser from READING a cross-origin HTTP response, but never stops the
 *     socket from connecting. Scanning localhost ports from a web page is a
 *     known, practical attack.
 *   - @fastify/cors is registered with `origin: true`, which reflects any Origin
 *     into Access-Control-Allow-Origin, so cross-origin fetch() reads of our
 *     HTTP routes succeed too.
 *
 * Defence is therefore the auth token (primary) plus a same-origin check
 * (defence in depth, and what blunts DNS rebinding). See
 * docs/design/standalone-terminal.md ("Security model").
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import {
  TERMINAL_CLOSE_NO_SESSION,
  TERMINAL_CLOSE_UNAUTHORIZED,
  TERMINAL_SESSION_API_PATH,
  TERMINAL_WS_PREFIX,
} from '../../core/src/constants.js';
import type { PtySessionManager } from './terminal/ptySessionManager.js';
import {
  encodeServerFrame,
  extractTokenFromProtocolHeader,
  isSameOrigin,
  isValidToken,
  parseClientFrame,
} from './terminal/terminalProtocol.js';

export interface TerminalRoutesOptions {
  token: string;
  ptyManager?: PtySessionManager;
}

/** Minimal structural view of the socket, so tests don't need a real WebSocket. */
interface TerminalSocket {
  readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  on(event: 'message', listener: (data: Buffer | string) => void): void;
  on(event: 'close', listener: () => void): void;
}

const WS_OPEN = 1;

export function registerTerminalRoutes(app: FastifyInstance, options: TerminalRoutesOptions): void {
  // The terminal feature is standalone-only; VS Code owns its own terminals.
  if (!options.ptyManager) return;
  const ptyManager = options.ptyManager;

  registerSessionRoute(app, options.token, ptyManager);
  registerTerminalSocketRoute(app, options.token, ptyManager);
}

/**
 * Hands the SPA the token it needs to open a terminal socket.
 *
 * The browser can't read ~/.pixel-agents/server.json, and the WebSocket
 * constructor can't set an Authorization header, so the token has to reach the
 * page over HTTP first. The same-origin guard is what stops any other site from
 * simply fetching it (cors({origin:true}) would otherwise allow exactly that).
 */
function registerSessionRoute(
  app: FastifyInstance,
  token: string,
  ptyManager: PtySessionManager,
): void {
  app.get(TERMINAL_SESSION_API_PATH, { preHandler: sameOriginOnly }, async () => ({
    token,
    available: ptyManager.isAvailable(),
    reason: ptyManager.unavailableReason() ?? undefined,
  }));
}

/** Must be async: Fastify only treats a 2-arg hook as promise-style when it
 *  returns a thenable. A sync hook that returns undefined without calling the
 *  third `next` argument hangs the request forever. Mirrors bearerAuth. */
async function sameOriginOnly(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  if (!isSameOrigin(request.headers.origin, request.headers.host)) {
    await reply.code(403).send('forbidden');
  }
}

function registerTerminalSocketRoute(
  app: FastifyInstance,
  token: string,
  ptyManager: PtySessionManager,
): void {
  app.get<{ Params: { agentId: string } }>(
    `${TERMINAL_WS_PREFIX}/:agentId`,
    {
      websocket: true,
      schema: {
        params: {
          type: 'object',
          properties: { agentId: { type: 'string', pattern: '^[0-9]+$' } },
          required: ['agentId'],
        },
      },
    },
    (socket: TerminalSocket, request) => {
      // ── Auth (before anything else touches a process) ──
      const provided = extractTokenFromProtocolHeader(request.headers['sec-websocket-protocol']);
      if (!isValidToken(provided, token)) {
        socket.close(TERMINAL_CLOSE_UNAUTHORIZED, 'unauthorized');
        return;
      }
      if (!isSameOrigin(request.headers.origin, request.headers.host)) {
        socket.close(TERMINAL_CLOSE_UNAUTHORIZED, 'forbidden origin');
        return;
      }

      const agentId = Number(request.params.agentId);
      const session = ptyManager.get(agentId);
      if (!session) {
        // Only attaches to PTYs this server spawned -- it can never start one.
        socket.close(TERMINAL_CLOSE_NO_SESSION, 'no terminal for agent');
        return;
      }

      const send = (data: string): void => {
        if (socket.readyState === WS_OPEN) socket.send(data);
      };

      // Replay buffered output first, so a reload/reconnect never shows a blank
      // terminal. Sent as one frame: xterm handles a large write fine, and it
      // keeps replay strictly ordered ahead of the live stream below.
      const backlog = session.scrollback();
      if (backlog.length > 0) {
        send(encodeServerFrame({ type: 'output', data: backlog }));
      }

      const offData = session.onData((chunk) => {
        send(encodeServerFrame({ type: 'output', data: chunk }));
      });

      const offExit = session.onExit((exit) => {
        send(encodeServerFrame({ type: 'exit', exitCode: exit.exitCode, signal: exit.signal }));
      });

      socket.on('message', (raw: Buffer | string) => {
        const frame = parseClientFrame(raw.toString());
        if (!frame) return; // Malformed/unknown frames are ignored, never thrown on.
        if (frame.type === 'input') {
          session.write(frame.data);
        } else {
          session.resize(frame.cols, frame.rows);
        }
      });

      socket.on('close', () => {
        // Detach only. The PTY outlives the socket so a reload reattaches to the
        // still-running Claude session; only closeAgent (or the process exiting)
        // ends it.
        offData();
        offExit();
      });
    },
  );
}

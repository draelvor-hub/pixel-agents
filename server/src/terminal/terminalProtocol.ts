/**
 * Terminal data-plane framing + auth. Deliberately outside the AsyncAPI
 * contract: this is a raw byte stream, not control-plane state.
 * See docs/design/standalone-terminal.md ("Transport: why raw I/O is outside
 * AsyncAPI").
 *
 * Everything here is a pure function over plain values so the security-relevant
 * decisions (is this token valid? is this origin ours?) are unit-testable
 * without a live socket.
 */

import * as crypto from 'crypto';

import { TERMINAL_WS_PROTOCOL } from '../../../core/src/constants.js';

// ── Frames ──────────────────────────────────────────────────────

/** server → client */
export type TerminalServerFrame =
  | { type: 'output'; data: string }
  | { type: 'exit'; exitCode: number; signal?: number };

/** client → server */
export type TerminalClientFrame =
  | { type: 'input'; data: string }
  | { type: 'resize'; cols: number; rows: number };

export function encodeServerFrame(frame: TerminalServerFrame): string {
  return JSON.stringify(frame);
}

/**
 * Parse a client frame. Returns null for anything malformed or unrecognized --
 * this input is attacker-reachable (it's a WebSocket), so it is validated
 * structurally and never trusted to be well-formed.
 */
export function parseClientFrame(raw: string): TerminalClientFrame | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;

  const frame = parsed as Record<string, unknown>;
  if (frame.type === 'input') {
    return typeof frame.data === 'string' ? { type: 'input', data: frame.data } : null;
  }
  if (frame.type === 'resize') {
    const { cols, rows } = frame;
    if (!isPositiveInt(cols) || !isPositiveInt(rows)) return null;
    return { type: 'resize', cols, rows };
  }
  return null;
}

function isPositiveInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

// ── Auth ────────────────────────────────────────────────────────

/**
 * Extract the auth token from a Sec-WebSocket-Protocol header.
 *
 * The client connects as `new WebSocket(url, [TERMINAL_WS_PROTOCOL, token])`,
 * so the header is `"pixel-agents.terminal.v1, <token>"`. The token rides here
 * rather than in the URL because standalone runs Fastify with `logger: true`,
 * which writes req.url to the log on every request -- a `?token=` param would
 * leak the token into stdout and log files. The browser WebSocket API cannot
 * set an Authorization header, so this is the only header available.
 */
export function extractTokenFromProtocolHeader(
  header: string | string[] | undefined,
): string | null {
  if (header === undefined) return null;
  const values = (Array.isArray(header) ? header.join(',') : header)
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0);

  if (values[0] !== TERMINAL_WS_PROTOCOL) return null;
  return values[1] ?? null;
}

/** Constant-time token comparison, mirroring httpServer's bearerAuth. */
export function isValidToken(provided: string | null, expected: string): boolean {
  if (provided === null) return false;
  const providedBuf = Buffer.from(provided);
  const expectedBuf = Buffer.from(expected);
  // timingSafeEqual throws on length mismatch; the length itself is not secret.
  if (providedBuf.length !== expectedBuf.length) return false;
  return crypto.timingSafeEqual(providedBuf, expectedBuf);
}

/**
 * Same-origin guard.
 *
 * Required because @fastify/cors is registered with `origin: true`, which
 * reflects ANY Origin into Access-Control-Allow-Origin -- without this check a
 * page on any site could fetch the terminal token cross-origin and then open a
 * shell (WebSocket connections are exempt from CORS entirely).
 *
 * Absent Origin is allowed: browsers omit it on same-origin GET and always send
 * it cross-origin, so "absent" means a non-browser caller (curl, a local
 * script) -- which can already read ~/.pixel-agents/server.json off disk, so
 * rejecting it would protect nothing while breaking legitimate local tooling.
 *
 * A DNS-rebound page still carries its real Origin (http://evil.com) and is
 * rejected here.
 */
export function isSameOrigin(origin: string | undefined, host: string | undefined): boolean {
  if (origin === undefined || origin === '') return true;
  if (host === undefined) return false;
  try {
    return new URL(origin).host === host;
  } catch {
    // Unparseable Origin -- not something a real browser sends. Refuse.
    return false;
  }
}

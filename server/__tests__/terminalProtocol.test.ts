import { describe, expect, it } from 'vitest';

import { TERMINAL_WS_PROTOCOL } from '../../core/src/constants.js';
import {
  encodeServerFrame,
  extractTokenFromProtocolHeader,
  isSameOrigin,
  isValidToken,
  parseClientFrame,
} from '../src/terminal/terminalProtocol.js';

describe('terminal message framing', () => {
  it('encodes output and exit frames', () => {
    expect(encodeServerFrame({ type: 'output', data: 'hi' })).toBe('{"type":"output","data":"hi"}');
    expect(encodeServerFrame({ type: 'exit', exitCode: 3 })).toBe('{"type":"exit","exitCode":3}');
  });

  it('round-trips control characters and multi-byte output through JSON', () => {
    // Terminal output is full of escape sequences; JSON escaping must not
    // corrupt them, since that would garble every TUI redraw.
    const data = '\x1b[31mred\x1b[0m\r\n\tünïcodé 🎉';
    const encoded = encodeServerFrame({ type: 'output', data });
    expect((JSON.parse(encoded) as { data: string }).data).toBe(data);
  });

  it('parses valid input and resize frames', () => {
    expect(parseClientFrame('{"type":"input","data":"ls\\r"}')).toEqual({
      type: 'input',
      data: 'ls\r',
    });
    expect(parseClientFrame('{"type":"resize","cols":120,"rows":40}')).toEqual({
      type: 'resize',
      cols: 120,
      rows: 40,
    });
  });

  it('rejects malformed, unknown, and wrongly-typed frames', () => {
    // This input arrives over an attacker-reachable socket, so anything that
    // isn't exactly right must be dropped rather than trusted.
    expect(parseClientFrame('not json')).toBeNull();
    expect(parseClientFrame('null')).toBeNull();
    expect(parseClientFrame('"a string"')).toBeNull();
    expect(parseClientFrame('{"type":"eval","data":"x"}')).toBeNull();
    expect(parseClientFrame('{"type":"input"}')).toBeNull();
    expect(parseClientFrame('{"type":"input","data":42}')).toBeNull();
    expect(parseClientFrame('{"type":"resize","cols":"80","rows":24}')).toBeNull();
    expect(parseClientFrame('{"type":"resize","cols":0,"rows":24}')).toBeNull();
    expect(parseClientFrame('{"type":"resize","cols":-1,"rows":24}')).toBeNull();
    expect(parseClientFrame('{"type":"resize","cols":80.5,"rows":24}')).toBeNull();
  });
});

describe('terminal token extraction', () => {
  it('extracts the token from a well-formed subprotocol header', () => {
    expect(extractTokenFromProtocolHeader(`${TERMINAL_WS_PROTOCOL}, abc-123`)).toBe('abc-123');
  });

  it('tolerates array headers and loose whitespace', () => {
    expect(extractTokenFromProtocolHeader([TERMINAL_WS_PROTOCOL, 'abc-123'])).toBe('abc-123');
    expect(extractTokenFromProtocolHeader(`${TERMINAL_WS_PROTOCOL},abc-123`)).toBe('abc-123');
  });

  it('returns null when the header is absent, empty, or a foreign protocol', () => {
    expect(extractTokenFromProtocolHeader(undefined)).toBeNull();
    expect(extractTokenFromProtocolHeader('')).toBeNull();
    expect(extractTokenFromProtocolHeader(TERMINAL_WS_PROTOCOL)).toBeNull();
    expect(extractTokenFromProtocolHeader('some.other.protocol, abc-123')).toBeNull();
  });
});

describe('terminal token validation', () => {
  it('accepts only the exact token', () => {
    expect(isValidToken('secret-token', 'secret-token')).toBe(true);
    expect(isValidToken('wrong-token!', 'secret-token')).toBe(false);
  });

  it('rejects null, empty, and length-mismatched tokens without throwing', () => {
    // timingSafeEqual throws on length mismatch -- the length pre-check must
    // absorb that rather than 500ing the upgrade.
    expect(isValidToken(null, 'secret')).toBe(false);
    expect(isValidToken('', 'secret')).toBe(false);
    expect(isValidToken('secret-but-longer', 'secret')).toBe(false);
    expect(isValidToken('sec', 'secret')).toBe(false);
  });
});

describe('terminal same-origin guard', () => {
  it('allows our own origin', () => {
    expect(isSameOrigin('http://127.0.0.1:3100', '127.0.0.1:3100')).toBe(true);
    expect(isSameOrigin('https://localhost:8080', 'localhost:8080')).toBe(true);
  });

  it('allows a missing origin (non-browser caller)', () => {
    // Browsers omit Origin on same-origin GET and always send it cross-origin,
    // so "absent" means curl or a local script -- which can already read the
    // token from ~/.pixel-agents/server.json.
    expect(isSameOrigin(undefined, '127.0.0.1:3100')).toBe(true);
    expect(isSameOrigin('', '127.0.0.1:3100')).toBe(true);
  });

  it('rejects a foreign origin, including a DNS-rebound one', () => {
    // The attack this exists to stop: cors({origin:true}) reflects any Origin,
    // so without this check evil.com could fetch the terminal token.
    expect(isSameOrigin('http://evil.com', '127.0.0.1:3100')).toBe(false);
    // DNS rebinding resolves evil.com to 127.0.0.1, but the page's Origin is
    // still evil.com.
    expect(isSameOrigin('http://evil.com', '127.0.0.1')).toBe(false);
    // Same host, different port is a different origin.
    expect(isSameOrigin('http://127.0.0.1:9999', '127.0.0.1:3100')).toBe(false);
  });

  it('rejects unparseable origins and a missing host', () => {
    expect(isSameOrigin('://nonsense', '127.0.0.1:3100')).toBe(false);
    expect(isSameOrigin('http://127.0.0.1:3100', undefined)).toBe(false);
  });
});

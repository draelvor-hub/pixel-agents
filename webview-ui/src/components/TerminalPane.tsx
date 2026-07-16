import { FitAddon } from '@xterm/addon-fit';
import { Terminal } from '@xterm/xterm';
import { useEffect, useRef } from 'react';

import {
  TERMINAL_FONT_FAMILY,
  TERMINAL_FONT_SIZE_PX,
  TERMINAL_RESIZE_DEBOUNCE_MS,
  TERMINAL_SCROLLBACK_LINES,
  TERMINAL_THEME,
} from '../constants.js';
import type { TerminalConnectionStatus } from '../terminal/terminalClient.js';
import { TerminalConnection } from '../terminal/terminalClient.js';

interface TerminalPaneProps {
  agentId: number;
  /** Hidden panes stay mounted so their xterm buffer and socket survive tab
   *  switches — unmounting would drop the scrollback and force a reconnect. */
  isActive: boolean;
  onStatusChange?: (agentId: number, status: TerminalConnectionStatus) => void;
}

/**
 * One xterm.js instance bound to one agent's PTY.
 *
 * xterm is imperative and owns its own DOM, so it lives outside React state and
 * is driven entirely through refs — the same pattern OfficeCanvas uses for the
 * game loop.
 */
export function TerminalPane({ agentId, isActive, onStatusChange }: TerminalPaneProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const termRef = useRef<Terminal | null>(null);

  // Keep the latest callback reachable without making it an effect dependency:
  // a caller passing an inline arrow would otherwise tear down the terminal and
  // reconnect the socket on every parent render.
  const statusRef = useRef(onStatusChange);
  statusRef.current = onStatusChange;

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const term = new Terminal({
      fontFamily: TERMINAL_FONT_FAMILY,
      fontSize: TERMINAL_FONT_SIZE_PX,
      theme: { ...TERMINAL_THEME },
      scrollback: TERMINAL_SCROLLBACK_LINES,
      cursorBlink: true,
      allowProposedApi: true,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host);
    termRef.current = term;
    fitRef.current = fit;

    const connection = new TerminalConnection(agentId, {
      onOutput: (data) => term.write(data),
      onExit: (exitCode) => {
        term.write(`\r\n\x1b[90m[process exited with code ${String(exitCode)}]\x1b[0m\r\n`);
      },
      onStatusChange: (status) => statusRef.current?.(agentId, status),
    });
    void connection.connect();

    term.onData((data) => connection.write(data));

    // Debounced: ResizeObserver fires per frame during a drag, and every resize
    // is a syscall on the PTY plus a full TUI repaint.
    let resizeTimer: ReturnType<typeof setTimeout> | null = null;
    const applyFit = () => {
      // A hidden pane has zero dimensions; fit() would compute a nonsense size
      // and resize the PTY to it.
      if (host.clientWidth === 0 || host.clientHeight === 0) return;
      try {
        fit.fit();
        connection.resize(term.cols, term.rows);
      } catch {
        // fit() throws if the element is mid-teardown; the next tick recovers.
      }
    };
    const scheduleFit = () => {
      if (resizeTimer) clearTimeout(resizeTimer);
      resizeTimer = setTimeout(applyFit, TERMINAL_RESIZE_DEBOUNCE_MS);
    };

    const observer = new ResizeObserver(scheduleFit);
    observer.observe(host);
    applyFit();

    return () => {
      if (resizeTimer) clearTimeout(resizeTimer);
      observer.disconnect();
      connection.dispose();
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
    };
  }, [agentId]);

  // Becoming visible: the pane had no dimensions while hidden, so re-fit and
  // focus now that it does.
  useEffect(() => {
    if (!isActive) return;
    const id = requestAnimationFrame(() => {
      try {
        fitRef.current?.fit();
      } catch {
        // Not laid out yet; the ResizeObserver will catch up.
      }
      termRef.current?.focus();
    });
    return () => cancelAnimationFrame(id);
  }, [isActive]);

  return (
    <div ref={hostRef} className="w-full h-full" style={{ display: isActive ? '' : 'none' }} />
  );
}

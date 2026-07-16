import { useCallback, useState } from 'react';

import {
  TERMINAL_DRAWER_COLLAPSED_HEIGHT_CSS,
  TERMINAL_DRAWER_COLLAPSED_HEIGHT_PX,
  TERMINAL_DRAWER_OPEN_HEIGHT_CSS,
} from '../constants.js';
import type { TerminalConnectionStatus } from '../terminal/terminalClient.js';
import { TerminalPane } from './TerminalPane.js';
import { Button } from './ui/Button.js';

interface TerminalDrawerProps {
  /** Agent ids with a live PTY, in open order. */
  agentIds: number[];
  activeAgentId: number | null;
  onSelectAgent: (agentId: number) => void;
  onCloseAgent: (agentId: number) => void;
  isOpen: boolean;
  onToggle: () => void;
}

const STATUS_DOT: Record<TerminalConnectionStatus, string> = {
  connecting: 'bg-status-permission',
  connected: 'bg-status-success',
  reconnecting: 'bg-status-permission',
  closed: 'bg-status-error',
};

/**
 * Bottom drawer hosting one xterm tab per launched agent.
 *
 * Standalone only — App gates rendering on terminalAvailable, which the server
 * only ever reports over the WebSocket transport. VS Code keeps using its own
 * terminal panel.
 */
export function TerminalDrawer({
  agentIds,
  activeAgentId,
  onSelectAgent,
  onCloseAgent,
  isOpen,
  onToggle,
}: TerminalDrawerProps) {
  const [statuses, setStatuses] = useState<Record<number, TerminalConnectionStatus>>({});

  const handleStatusChange = useCallback((agentId: number, status: TerminalConnectionStatus) => {
    setStatuses((prev) => (prev[agentId] === status ? prev : { ...prev, [agentId]: status }));
  }, []);

  if (agentIds.length === 0) return null;

  // Fall back to the first tab when the active agent has no terminal (e.g. the
  // user clicked an externally-detected character, which has no PTY).
  const activeId =
    activeAgentId !== null && agentIds.includes(activeAgentId) ? activeAgentId : agentIds[0];

  return (
    <div
      className="absolute bottom-0 left-0 right-0 z-30 flex flex-col bg-bg border-t-2 border-border"
      style={{
        height: isOpen ? TERMINAL_DRAWER_OPEN_HEIGHT_CSS : TERMINAL_DRAWER_COLLAPSED_HEIGHT_CSS,
      }}
    >
      {/* Tab bar. Fixed height so the collapsed drawer is exactly
          TERMINAL_DRAWER_COLLAPSED_HEIGHT_CSS tall — the BottomToolbar lifts by
          that same value, and a drifting tab-bar height would leave it either
          overlapping the drawer or floating above a gap. */}
      <div
        className="flex items-center gap-2 px-4 border-b-2 border-border shrink-0"
        style={{ height: TERMINAL_DRAWER_COLLAPSED_HEIGHT_PX }}
      >
        {agentIds.map((agentId) => {
          const isActive = agentId === activeId && isOpen;
          const status = statuses[agentId] ?? 'connecting';
          return (
            <div
              key={agentId}
              className={`flex items-center gap-4 px-8 py-3 cursor-pointer border-2 ${
                isActive
                  ? 'bg-active-bg border-accent'
                  : 'bg-btn-bg border-transparent hover:bg-btn-hover'
              }`}
              onClick={() => onSelectAgent(agentId)}
            >
              <span
                className={`w-6 h-6 rounded-full inline-block shrink-0 ${STATUS_DOT[status]}`}
              />
              <span className="text-sm">Agent {agentId}</span>
              <span
                className="text-sm text-text-muted hover:text-danger px-2"
                title="Close agent"
                onClick={(e) => {
                  // Don't also select the tab we're about to remove.
                  e.stopPropagation();
                  onCloseAgent(agentId);
                }}
              >
                ✕
              </span>
            </div>
          );
        })}
        <div className="ml-auto">
          <Button
            variant="ghost"
            size="sm"
            onClick={onToggle}
            title={isOpen ? 'Collapse' : 'Expand'}
          >
            {isOpen ? '▼' : '▲'}
          </Button>
        </div>
      </div>

      {/* Panes: all mounted, only the active one shown. Unmounting would drop
          xterm's buffer and force a socket reconnect on every tab switch. */}
      {isOpen && (
        <div className="relative flex-1 min-h-0 p-4">
          {agentIds.map((agentId) => (
            <div key={agentId} className="absolute inset-4">
              <TerminalPane
                agentId={agentId}
                isActive={agentId === activeId}
                onStatusChange={handleStatusChange}
              />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

import { useState } from 'react';

import { Button } from './ui/Button.js';
import { Modal } from './ui/Modal.js';

interface SubagentNamesModalProps {
  isOpen: boolean;
  onClose: () => void;
  subagentNames: Record<string, string>;
  onRenameSubagentType: (subagentType: string, name: string) => void;
}

/** Sub-window off the main Settings modal: existing subagent_type -> name
 *  rows (editable name, removable), a filter box, and an add-row for a new
 *  subagent_type. Persistent per-type, not per-invocation — see
 *  officeState.renameSubagentType. Split out from the main Settings modal
 *  because the persona roster runs into the dozens, which made a single
 *  flat Settings list unmanageably long. */
export function SubagentNamesModal({
  isOpen,
  onClose,
  subagentNames,
  onRenameSubagentType,
}: SubagentNamesModalProps) {
  const [filter, setFilter] = useState('');
  const [newType, setNewType] = useState('');
  const [newName, setNewName] = useState('');

  const entries = Object.entries(subagentNames).sort(([a], [b]) => a.localeCompare(b));
  const query = filter.trim().toLowerCase();
  const filtered = query
    ? entries.filter(
        ([type, name]) => type.toLowerCase().includes(query) || name.toLowerCase().includes(query),
      )
    : entries;

  const addEntry = () => {
    const type = newType.trim();
    const name = newName.trim();
    if (!type || !name) return;
    onRenameSubagentType(type, name);
    setNewType('');
    setNewName('');
  };

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={<span className="text-2xl">Subagent Names ({entries.length})</span>}
      zIndex={51}
      className="min-w-sm!"
    >
      <div className="flex flex-col gap-4 py-4 px-10">
        <input
          data-testid="subagent-name-filter"
          className="text-xs bg-btn-bg text-text border-2 border-border rounded-none px-2 py-2 w-full min-w-0"
          placeholder="Filter by type or name…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />

        <div className="flex flex-col gap-4 max-h-[50vh] overflow-y-auto">
          {filtered.length === 0 && (
            <span className="text-xs text-text-muted py-4">No subagents match "{filter}".</span>
          )}
          {filtered.map(([type, name]) => (
            <div key={type} className="flex items-center gap-4">
              <span
                className="text-xs text-text-muted overflow-hidden text-ellipsis whitespace-nowrap flex-1"
                title={type}
              >
                {type}
              </span>
              <input
                data-testid={`subagent-name-input-${type}`}
                className="text-sm bg-btn-bg text-text border-2 border-border rounded-none px-2 py-0 w-96 min-w-0"
                defaultValue={name}
                onBlur={(e) => onRenameSubagentType(type, e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') e.currentTarget.blur();
                }}
              />
              <Button
                variant="ghost"
                size="sm"
                onClick={() => onRenameSubagentType(type, '')}
                className="shrink-0"
              >
                x
              </Button>
            </div>
          ))}
        </div>

        <div className="flex items-center gap-4 pt-4 border-t border-border">
          <input
            data-testid="subagent-name-new-type"
            className="text-xs bg-btn-bg text-text border-2 border-border rounded-none px-2 py-0 flex-1 min-w-0"
            placeholder="subagent type (e.g. office-architect)"
            value={newType}
            onChange={(e) => setNewType(e.target.value)}
          />
          <input
            data-testid="subagent-name-new-name"
            className="text-sm bg-btn-bg text-text border-2 border-border rounded-none px-2 py-0 w-96 min-w-0"
            placeholder="name"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') addEntry();
            }}
          />
          <Button variant="ghost" size="sm" onClick={addEntry} className="shrink-0">
            Add
          </Button>
        </div>
      </div>
    </Modal>
  );
}

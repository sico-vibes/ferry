import { FolderOpen, GitBranch } from 'lucide-react';
import type { FileChange, SessionDetail, Workspace } from '@ferry/shared';
import { useUI } from '../state/ui';

/** Latest change per file across the chat's tool calls. */
export function sessionChanges(messages: SessionDetail['messages']): FileChange[] {
  const byPath = new Map<string, FileChange>();
  for (const message of messages)
    for (const part of message.parts)
      if (part.type === 'tool_call')
        for (const change of part.changes) byPath.set(change.path, change);
  return [...byPath.values()];
}

/**
 * One quiet line above the composer: where this chat works and what it changed
 * (project · branch · +lines −lines · Review changes), like the branch bar in Claude Code.
 */
export function ContextStrip({
  workspace,
  messages,
}: {
  workspace: Workspace | undefined;
  messages: SessionDetail['messages'];
}) {
  const changes = sessionChanges(messages);
  if (!workspace && changes.length === 0) return null;
  const additions = changes.reduce((total, change) => total + change.additions, 0);
  const deletions = changes.reduce((total, change) => total + change.deletions, 0);
  const openChanges = () => {
    const ui = useUI.getState();
    ui.setRightTab('changes');
    if (ui.rightCollapsed) ui.toggleRight();
  };
  return (
    <div className="v2-context-strip" aria-label="Chat context">
      {workspace && (
        <span className="v2-context-item" title={workspace.path}>
          <FolderOpen aria-hidden="true" size={14} strokeWidth={1.75} />
          {workspace.name}
        </span>
      )}
      {workspace?.gitBranch && (
        <span className="v2-context-item is-mono" title={`Branch ${workspace.gitBranch}`}>
          <GitBranch aria-hidden="true" size={14} strokeWidth={1.75} />
          {workspace.gitBranch}
        </span>
      )}
      {changes.length > 0 && (
        <>
          <span
            className="v2-context-diff"
            aria-label={`${String(changes.length)} files changed, ${String(additions)} lines added, ${String(deletions)} removed`}
          >
            <span className="is-add">+{additions}</span>
            <span className="is-del">−{deletions}</span>
          </span>
          <button className="v2-context-action" onClick={openChanges} type="button">
            Review {changes.length === 1 ? '1 file' : `${String(changes.length)} files`}
          </button>
        </>
      )}
    </div>
  );
}

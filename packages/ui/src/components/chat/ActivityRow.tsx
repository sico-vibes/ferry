import { useEffect, useState } from 'react';
import { ChevronRight, LoaderCircle } from 'lucide-react';
import type { MessagePart } from '@ferry/shared';
import { cn } from '../../lib/cn';
import { focusRingClass } from '../primitives';

type ToolPart = Extract<MessagePart, { type: 'tool_call' }>;

const plural = (count: number, one: string, many = `${one}s`) =>
  `${String(count)} ${count === 1 ? one : many}`;

/** Distinct workspace paths a group of tool calls touched, for "Edited 2 files". */
function touchedPaths(parts: readonly ToolPart[]): number {
  const paths = new Set<string>();
  for (const part of parts) {
    for (const change of part.changes) paths.add(change.path);
    if (!part.changes.length && typeof part.args.path === 'string') paths.add(part.args.path);
  }
  return Math.max(paths.size, parts.length ? 1 : 0);
}

/**
 * One past-tense line for a stretch of tool work, the way Claude Code summarizes it:
 * "Read 3 files, searched code, ran 2 commands".
 */
export function summarizeActivity(parts: readonly ToolPart[]): string {
  const by = (...tools: string[]) => parts.filter((part) => tools.includes(part.tool));
  const reads = by('read_file', 'read_output');
  const searches = by('grep', 'glob');
  const explores = by('list_dir', 'repo_map');
  const creates = parts.filter(
    (part) => part.tool === 'write_file' && part.changes.every((change) => change.deletions === 0),
  );
  const edits = parts.filter(
    (part) =>
      ['edit_file', 'apply_patch'].includes(part.tool) ||
      (part.tool === 'write_file' && !creates.includes(part)),
  );
  const commands = by('run_command');
  const pages = by('check_page');
  const plans = by('update_plan', 'record_decision');
  const known = new Set([
    ...reads,
    ...searches,
    ...explores,
    ...creates,
    ...edits,
    ...commands,
    ...pages,
    ...plans,
  ]);
  const other = parts.filter((part) => !known.has(part));
  const phrases = [
    explores.length ? `explored ${plural(explores.length, 'folder')}` : '',
    searches.length
      ? searches.length === 1
        ? 'searched code'
        : `searched ${plural(searches.length, 'time')}`
      : '',
    reads.length ? `read ${plural(reads.length, 'file')}` : '',
    creates.length ? `created ${plural(touchedPaths(creates), 'file')}` : '',
    edits.length ? `edited ${plural(touchedPaths(edits), 'file')}` : '',
    commands.length ? `ran ${plural(commands.length, 'command')}` : '',
    pages.length ? `checked ${plural(pages.length, 'page')} in a browser` : '',
    plans.length ? 'updated the plan' : '',
    other.length ? `used ${plural(other.length, 'tool')}` : '',
  ].filter(Boolean);
  const text = phrases.join(', ');
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : 'Worked';
}

/** Total lines added and removed across a stretch of tool work. */
export function activityDiff(parts: readonly ToolPart[]): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;
  for (const part of parts)
    for (const change of part.changes) {
      additions += change.additions;
      deletions += change.deletions;
    }
  return { additions, deletions };
}

/**
 * A quiet, single-line summary of consecutive tool calls that expands into the individual steps.
 * While a step runs the line shows that step in the present tense; failures open it automatically.
 */
export function ActivityRow({
  parts,
  renderSteps,
}: {
  parts: readonly ToolPart[];
  /** The detailed step list shown when the row is expanded. */
  renderSteps: () => React.ReactNode;
}) {
  const running = parts.find((part) => part.status === 'running' || part.status === 'pending');
  const failed = parts.filter((part) => part.status === 'failed').length;
  const denied = parts.filter((part) => part.status === 'denied').length;
  const [open, setOpen] = useState(failed > 0);
  useEffect(() => {
    if (failed > 0) setOpen(true);
  }, [failed]);
  const diff = activityDiff(parts);
  const label = running ? `${running.title.replace(/[.…]+$/, '')}…` : summarizeActivity(parts);
  return (
    <div className={cn('activity-row', running && 'is-running', open && 'is-open')}>
      <button
        aria-expanded={open}
        className={`activity-row-toggle ${focusRingClass}`}
        onClick={() => {
          setOpen(!open);
        }}
        type="button"
      >
        {running && <LoaderCircle aria-hidden="true" className="activity-row-spinner" size={14} />}
        <span className="activity-row-label">{label}</span>
        {failed > 0 && <span className="activity-row-failed">{plural(failed, 'step')} failed</span>}
        {denied > 0 && <span className="activity-row-denied">{plural(denied, 'step')} denied</span>}
        {(diff.additions > 0 || diff.deletions > 0) && (
          <span
            className="activity-row-diff"
            aria-label={`${String(diff.additions)} lines added, ${String(diff.deletions)} removed`}
          >
            <span className="is-add">+{diff.additions}</span>
            <span className="is-del">−{diff.deletions}</span>
          </span>
        )}
        <ChevronRight aria-hidden="true" className="activity-row-chevron" size={14} />
      </button>
      {open && <div className="activity-steps">{renderSteps()}</div>}
    </div>
  );
}

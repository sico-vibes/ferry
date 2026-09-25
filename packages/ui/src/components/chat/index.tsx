import { lazy, Suspense, useEffect, useState, type ReactNode } from 'react';
import {
  ArrowLeftRight,
  ChevronDown,
  ChevronRight,
  CircleHelp,
  FilePen,
  FilePlus,
  FileText,
  Files,
  FolderTree,
  GitBranch,
  ListChecks,
  Network,
  Plug,
  Search,
  ShieldAlert,
  SquareTerminal,
  Users,
  Wrench,
  type LucideIcon,
} from 'lucide-react';
import type { FileChange, MessagePart, PlanItem, ToolName, ToolOutput } from '@ferry/shared';
import { FerryMark } from '../../brand/FerryMark';
import { CountUp } from '../data/CountUp';
import { ReactBitsThinkingLine } from './ThinkingLine';
import { AdaptedStatusMark } from './StatusMark';
import { ShinyText } from '../../effects/ShinyText';
import { cn } from '../../lib/cn';
import { Pill, focusRingClass } from '../primitives';

const MarkdownContent = lazy(() =>
  import('./MarkdownContent').then((module) => ({ default: module.MarkdownContent })),
);

export function UserMessage({ children }: { children: ReactNode }) {
  return (
    <div className="flex justify-end">
      <div className="max-w-[70%] rounded-2xl bg-raised px-4 py-3 text-chat text-text-1">
        {children}
      </div>
    </div>
  );
}
export function ModelBadge({ modelName }: { modelName: string }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-meta font-medium text-text-3">
      <FerryMark className="text-text-3" decorative size={12} variant="mono" />
      {modelName}
    </span>
  );
}
export function AssistantMessage({
  modelName,
  children,
}: {
  modelName: string;
  children: ReactNode;
}) {
  return (
    <article className="space-y-3">
      <ModelBadge modelName={modelName} />
      <div className="space-y-3 text-chat leading-6 text-text-1">{children}</div>
    </article>
  );
}

export function MarkdownPart({ content }: { content: string }) {
  return (
    <div className="prose prose-invert max-w-none text-chat [&_a]:text-link [&_a]:underline [&_code:not(pre_code)]:rounded-md [&_code:not(pre_code)]:bg-raised [&_code:not(pre_code)]:px-1.5 [&_code:not(pre_code)]:py-0.5 [&_pre]:overflow-auto [&_pre]:rounded-xl [&_pre]:border [&_pre]:border-border-hair [&_pre]:bg-card [&_pre]:p-4 [&_pre]:leading-4 [&_table]:border-collapse [&_td]:border [&_td]:border-border-hair [&_td]:px-2 [&_th]:border [&_th]:border-border-hair [&_th]:px-2">
      <Suspense fallback={<span>{content}</span>}>
        <MarkdownContent content={content} />
      </Suspense>
    </div>
  );
}
export function ThinkingLine({
  steps = [],
  startedAt = Date.now(),
  running = false,
}: {
  steps?: { label: string; status: 'pending' | 'active' | 'done' }[];
  startedAt?: number;
  running?: boolean;
}) {
  const elapsed = Math.max(0, (Date.now() - startedAt) / 1000).toFixed(1);
  return (
    <div className="text-label text-text-3">
      {running ? <ShinyText>Thinking…</ShinyText> : 'Thought'} · {elapsed}s
      {steps.length > 0 && (
        <ul className="mt-2 space-y-1">
          {steps.map((step) => (
            <li className={step.status === 'active' ? 'text-text-2' : ''} key={step.label}>
              {step.status === 'done' ? '✓' : step.status === 'active' ? '◌' : '○'} {step.label}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
export function ReasoningPart({
  text,
  steps = [],
}: {
  text: string;
  steps?: { label: string; status: 'pending' | 'active' | 'done' }[];
}) {
  const [open, setOpen] = useState(false);
  return (
    <section className="rounded-xl border border-border-hair bg-card">
      <button
        aria-expanded={open}
        className={`flex w-full items-center gap-2 p-3 text-left ${focusRingClass}`}
        onClick={() => {
          setOpen(!open);
        }}
        type="button"
      >
        <ChevronRight className={cn('size-4 transition-transform', open && 'rotate-90')} />
        <span className="text-label text-text-3">Thinking</span>
      </button>
      {open && (
        <div className="space-y-2 px-3 pb-3">
          <ReactBitsThinkingLine steps={steps} running />
          <p className="whitespace-pre-wrap text-label leading-5 text-text-2">{text}</p>
        </div>
      )}
    </section>
  );
}
const tools: Record<string, LucideIcon> = {
  read_file: FileText,
  edit_file: FilePen,
  write_file: FilePlus,
  grep: Search,
  glob: Files,
  list_dir: FolderTree,
  run_command: SquareTerminal,
  repo_map: Network,
  update_plan: ListChecks,
  delegate: Users,
  mcp: Plug,
};
export function StatusMark({
  status,
}: {
  status: 'pending' | 'running' | 'succeeded' | 'failed' | 'denied';
}) {
  return <AdaptedStatusMark status={status} />;
}
export function FilteredOutputBadge({
  output,
  onShowFull,
}: {
  output: ToolOutput;
  onShowFull?: (recoveryHandle: string) => void;
}) {
  if (!output.filtered) return null;
  const recoveryHandle = output.recoveryHandle;
  return (
    <span className="inline-flex items-center gap-2 text-meta text-text-3">
      Filtered · <CountUp to={output.originalTokens ?? 0} /> →{' '}
      <CountUp to={output.filteredTokens ?? 0} /> tokens{' '}
      {recoveryHandle && (
        <button
          className="text-link hover:underline"
          onClick={() => {
            onShowFull?.(recoveryHandle);
          }}
          type="button"
        >
          Show full
        </button>
      )}
    </span>
  );
}
export function ToolCallBlock({
  tool,
  title,
  args,
  status,
  output,
  changes = [],
  durationMs,
  onShowFull,
  onOpenDiff,
}: {
  tool: ToolName;
  title: string;
  args: Record<string, unknown>;
  status: 'pending' | 'running' | 'succeeded' | 'failed' | 'denied';
  output: ToolOutput | null;
  changes?: FileChange[];
  durationMs?: number | null;
  onShowFull?: (handle: string) => void;
  onOpenDiff?: (path: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const Icon = tool.startsWith('mcp__') ? Plug : (tools[tool] ?? Wrench);
  return (
    <section className="overflow-hidden rounded-xl border border-border-hair bg-card">
      <button
        aria-expanded={open}
        className={`flex w-full items-center gap-2.5 px-3 py-3 text-left ${focusRingClass}`}
        onClick={() => {
          setOpen(!open);
        }}
        type="button"
      >
        <Icon size={15} className="text-text-2" />
        <span className="min-w-0 flex-1 truncate text-label font-medium text-text-1">{title}</span>
        <StatusMark status={status} />
        {durationMs != null && (
          <span className="text-meta tabular-nums text-text-3">
            {(durationMs / 1000).toFixed(1)}s
          </span>
        )}
        <ChevronDown className={cn('size-3.5 text-text-3 transition', open && 'rotate-180')} />
      </button>
      {open && (
        <div className="space-y-2 border-t border-border-hair p-3">
          <p className="font-mono text-[11px] leading-4 text-text-3">
            {Object.entries(args)
              .map(
                ([key, value]) =>
                  `${key}: ${typeof value === 'string' ? value : JSON.stringify(value)}`,
              )
              .join(' · ')}
          </p>
          {output && (
            <>
              <FilteredOutputBadge {...(onShowFull ? { onShowFull } : {})} output={output} />
              <pre className="max-h-[280px] overflow-auto whitespace-pre-wrap break-all rounded-lg bg-input p-2.5 font-mono text-[11px] leading-4 text-text-2">
                {output.text}
              </pre>
            </>
          )}
          {changes.map((change) => (
            <button
              className="flex w-full items-center gap-2 text-left font-mono text-[11px] text-text-2 hover:text-text-1"
              key={change.path}
              onClick={() => onOpenDiff?.(change.path)}
              type="button"
            >
              <GitBranch size={13} />
              <span className="flex-1 truncate">{change.path}</span>
              <span className="text-success">+{change.additions}</span>
              <span className="text-danger">−{change.deletions}</span>
            </button>
          ))}
        </div>
      )}
    </section>
  );
}

export type PartGroup =
  MessagePart | { type: 'tool_group'; parts: Extract<MessagePart, { type: 'tool_call' }>[] };

export function groupParts(parts: MessagePart[]): PartGroup[] {
  const groups: PartGroup[] = [];
  for (let index = 0; index < parts.length;) {
    const part = parts[index];
    if (part?.type !== 'tool_call') {
      if (part) groups.push(part);
      index += 1;
      continue;
    }
    const tools: Extract<MessagePart, { type: 'tool_call' }>[] = [];
    while (parts[index]?.type === 'tool_call') {
      const candidate = parts[index];
      if (candidate?.type === 'tool_call') tools.push(candidate);
      index += 1;
    }
    if (tools.length === 1) {
      const single = tools.at(0);
      if (single) groups.push(single);
    } else groups.push({ type: 'tool_group', parts: tools });
  }
  return groups;
}

export function ToolStepGroup({
  parts,
  onShowFull,
  onOpenDiff,
}: {
  parts: Extract<MessagePart, { type: 'tool_call' }>[];
  onShowFull?: (text: string) => void;
  onOpenDiff?: () => void;
}) {
  const failed = parts.some((part) => part.status === 'failed');
  const running = parts.at(-1)?.status === 'running';
  const [open, setOpen] = useState(failed || running);
  useEffect(() => {
    if (failed || running) setOpen(true);
  }, [failed, running]);
  const totals = new Map<string, number>();
  for (const part of parts) totals.set(part.tool, (totals.get(part.tool) ?? 0) + 1);
  const count = (...names: string[]) =>
    names.reduce((sum, name) => sum + (totals.get(name) ?? 0), 0);
  const summaries = [
    count('read_file', 'list_dir', 'glob', 'repo_map')
      ? `Explored ${String(count('read_file', 'list_dir', 'glob', 'repo_map'))} files`
      : '',
    count('grep') ? `searched ${String(count('grep'))}` : '',
    count('edit_file', 'write_file') ? `edited ${String(count('edit_file', 'write_file'))}` : '',
    count('run_command')
      ? `ran ${String(count('run_command'))} ${count('run_command') === 1 ? 'command' : 'commands'}`
      : '',
    count('update_plan') ? `updated plan ${String(count('update_plan'))}` : '',
    count('mcp', 'delegate') ? `used ${String(count('mcp', 'delegate'))} other tools` : '',
  ].filter(Boolean);
  const summary = summaries.join(' · ');
  const overall = failed
    ? 'failed'
    : running
      ? 'running'
      : parts.some((part) => part.status === 'denied')
        ? 'denied'
        : parts.every((part) => part.status === 'succeeded')
          ? 'succeeded'
          : 'pending';
  const elapsed = parts.reduce((sum, part) => sum + (part.durationMs ?? 0), 0);
  return (
    <section className="overflow-hidden rounded-xl border border-border-hair bg-card">
      <button
        aria-expanded={open}
        className={`flex w-full items-center gap-2.5 px-3 py-3 text-left ${focusRingClass}`}
        onClick={() => {
          setOpen(!open);
        }}
        type="button"
      >
        <span className="flex -space-x-1 text-text-2">
          <Wrench size={15} />
          <Wrench size={12} />
        </span>
        <span className="min-w-0 flex-1 truncate text-label font-medium text-text-1">
          {summary}
        </span>
        <StatusMark status={overall} />
        {elapsed > 0 && (
          <span className="text-meta tabular-nums text-text-3">{(elapsed / 1000).toFixed(1)}s</span>
        )}
        <ChevronDown className={cn('size-3.5 text-text-3 transition', open && 'rotate-180')} />
      </button>
      {open && (
        <div className="space-y-2 border-t border-border-hair p-3">
          {parts.map((part) => (
            <ToolCallBlock
              key={part.id}
              {...part}
              {...(onShowFull
                ? {
                    onShowFull: () => {
                      onShowFull(
                        `${part.output?.text ?? ''}\n\nFull output restored from recovery handle.`,
                      );
                    },
                  }
                : {})}
              {...(onOpenDiff
                ? {
                    onOpenDiff: () => {
                      onOpenDiff();
                    },
                  }
                : {})}
            />
          ))}
        </div>
      )}
    </section>
  );
}
export type ApprovalDecision = 'allow_once' | 'always_allow' | 'deny';
export function ApprovalCard({
  kind,
  summary,
  detail,
  risk,
  state = 'pending',
  onRespond,
}: {
  kind: string;
  summary: string;
  detail: string;
  risk: 'low' | 'medium' | 'high';
  state?: 'pending' | 'allowed_once' | 'allowed_always' | 'denied';
  onRespond?: (decision: ApprovalDecision) => void;
}) {
  const resolved = state !== 'pending';
  return (
    <section className="space-y-3 rounded-xl border border-warn/30 bg-warn/5 p-3.5">
      <div className="flex items-center gap-2">
        <ShieldAlert size={16} className="text-warn" />
        <span className="text-label font-medium">{summary}</span>
        <span className="ml-auto rounded-pill bg-raised px-2 py-1 text-meta capitalize text-text-2">
          {risk} risk
        </span>
      </div>
      <p className="text-label text-text-2">{kind}</p>
      <pre className="whitespace-pre-wrap break-all rounded-lg bg-input p-2 font-mono text-[11px] text-text-3">
        {detail}
      </pre>
      {resolved ? (
        <p className="text-label text-text-3">{state.replace('_', ' ')} · resolved</p>
      ) : (
        <div className="flex gap-2">
          <Pill size="sm" onClick={() => onRespond?.('allow_once')}>
            Allow once
          </Pill>
          <Pill size="sm" onClick={() => onRespond?.('always_allow')}>
            Always allow
          </Pill>
          <Pill size="sm" variant="warm-outline" onClick={() => onRespond?.('deny')}>
            Deny
          </Pill>
        </div>
      )}
    </section>
  );
}
export function HandoffMarker({
  from,
  to,
  reason,
  briefingTokens,
  explanation,
}: {
  from: string;
  to: string;
  reason: string;
  briefingTokens: number;
  explanation: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="my-2 text-center">
      <button
        className={`inline-flex max-w-full flex-wrap items-center justify-center gap-1.5 rounded-pill border border-blue-500/30 bg-blue-500/5 px-3 py-2 text-meta text-text-2 shadow-[0_0_16px_var(--spotlight)] ${focusRingClass}`}
        onClick={() => {
          setOpen(!open);
        }}
        type="button"
      >
        <ArrowLeftRight size={13} />
        <span>
          Switched <b className="text-text-1">{from}</b> → <b className="text-text-1">{to}</b> ·{' '}
          {reason} · task briefed ({(briefingTokens / 1000).toFixed(1)}K tokens)
        </span>
      </button>
      {open && <p className="mx-auto mt-2 max-w-lg text-meta text-text-3">{explanation}</p>}
    </div>
  );
}
export function DelegationCard({
  lane,
  implementer,
  status,
  progress,
  usage,
  onReviewDiff,
  onCancel,
}: {
  lane: string;
  implementer: string;
  status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
  progress: string;
  usage: string;
  onReviewDiff?: () => void;
  onCancel?: () => void;
}) {
  return (
    <section className="space-y-2 rounded-xl border border-border-hair bg-card p-3">
      <header className="flex items-center gap-2">
        <Users size={15} className="text-link" />
        <b className="text-label">{lane}</b>
        <span className="text-meta text-text-3">· {implementer}</span>
        <Pill className="ml-auto h-6 px-2 text-[10px] capitalize" size="sm">
          {status}
        </Pill>
      </header>
      <p className="text-label text-text-2">{progress}</p>
      <footer className="flex items-center justify-between">
        <span className="text-meta text-text-3">{usage}</span>
        <span className="flex gap-2">
          <button className="text-meta text-link" onClick={onReviewDiff} type="button">
            Review diff
          </button>
          {status === 'running' && (
            <button className="text-meta text-text-3" onClick={onCancel} type="button">
              Cancel
            </button>
          )}
        </span>
      </footer>
    </section>
  );
}
export function CheckpointMarker({ label, onRestore }: { label: string; onRestore?: () => void }) {
  return (
    <div className="flex items-center gap-3 py-1 text-meta text-text-3">
      <span className="h-px flex-1 bg-border-hair" />
      Checkpoint · {label}
      <button className="text-link hover:underline" onClick={onRestore} type="button">
        Restore
      </button>
      <span className="h-px flex-1 bg-border-hair" />
    </div>
  );
}
export function ErrorPart({ message }: { message: string }) {
  return (
    <div className="flex items-center gap-2 rounded-lg border border-danger/20 bg-danger/5 p-3 text-label text-danger">
      <CircleHelp size={15} />
      {message}
    </div>
  );
}
export function StreamingCursor() {
  return (
    <span
      aria-label="Streaming"
      className="inline-block h-4 w-1.5 animate-pulse bg-blue-500 align-middle motion-reduce:animate-none"
    />
  );
}
export type ChatMessagePart = MessagePart | PlanItem;

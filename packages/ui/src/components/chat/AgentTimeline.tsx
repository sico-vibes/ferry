import { Children, useEffect, useState, type ReactNode } from 'react';
import { ChevronDown, ChevronRight, CircleDot, LoaderCircle, Wrench } from 'lucide-react';
import { formatRunReport, type AgentEvent, type RunReport } from '@ferry/shared';
import { cn } from '../../lib/cn';
import { focusRingClass } from '../primitives';

export interface ToolTimelineStep {
  call: Extract<AgentEvent, { type: 'tool_use' }>;
  result?: Extract<AgentEvent, { type: 'tool_result' }>;
}
export type TimelineToolItem =
  ToolTimelineStep | { type: 'group'; tool: string; steps: ToolTimelineStep[] };

export function buildTimelineLanes(events: readonly AgentEvent[]): {
  model: AgentEvent[];
  tools: TimelineToolItem[];
} {
  const results = new Map<string, Extract<AgentEvent, { type: 'tool_result' }>>();
  for (const event of events) if (event.type === 'tool_result') results.set(event.callId, event);
  const model = events.filter((event) => event.type !== 'tool_use' && event.type !== 'tool_result');
  const calls: { step: ToolTimelineStep; position: number }[] = events.flatMap(
    (event, position) => {
      if (event.type !== 'tool_use') return [];
      const result = results.get(event.callId);
      return [{ step: { call: event, ...(result ? { result } : {}) }, position }];
    },
  );
  const tools: TimelineToolItem[] = [];
  for (let index = 0; index < calls.length;) {
    const firstEntry = calls[index];
    const first = firstEntry?.step;
    if (!first) break;
    const name = first.call.tool.toLowerCase();
    const input = first.call.input;
    const hasShellCommand = Boolean(input && typeof input === 'object' && 'command' in input);
    if (
      hasShellCommand ||
      name === 'shell' ||
      name === 'run_command' ||
      name === 'bash' ||
      name === 'terminal'
    ) {
      tools.push(first);
      index += 1;
      continue;
    }
    let end = index + 1;
    while (end < calls.length && calls[end]?.step.call.tool === first.call.tool) {
      const previous = calls[end - 1];
      const next = calls[end];
      if (
        !previous ||
        !next ||
        events
          .slice(previous.position + 1, next.position)
          .some((event) => event.type !== 'tool_result' && event.type !== 'tool_use')
      )
        break;
      const nextInput = next.step.call.input;
      if (nextInput && typeof nextInput === 'object' && 'command' in nextInput) break;
      end += 1;
    }
    const consecutive = calls.slice(index, end).map((item) => item.step);
    if (consecutive.length >= 3)
      tools.push({ type: 'group', tool: first.call.tool, steps: consecutive });
    else tools.push(...consecutive);
    index = end;
  }
  return { model, tools };
}

function prettyTool(tool: string): string {
  return tool.replace(/^mcp__/, '').replaceAll('_', ' ');
}
function compactTokens(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(value >= 10_000_000 ? 0 : 1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(value >= 10_000 ? 0 : 1)}k`;
  return String(value);
}

const usageSegments = [
  { key: 'input', label: 'in', color: 'var(--ring)' },
  { key: 'output', label: 'out', color: 'var(--success)' },
  { key: 'reasoning', label: 'reasoning', color: 'var(--warning)' },
] as const;

/** One row for the whole reply: token split as a bar, total, and how full the context window is. */
export function UsageSummary({
  events,
  contextWindow,
}: {
  events: readonly AgentEvent[];
  contextWindow?: number | undefined;
}) {
  const usage = events.filter(
    (event): event is Extract<AgentEvent, { type: 'usage' }> => event.type === 'usage',
  );
  if (!usage.length) return null;
  const totals = {
    input: usage.reduce((sum, event) => sum + (event.inputTokens ?? 0), 0),
    output: usage.reduce((sum, event) => sum + (event.outputTokens ?? 0), 0),
    reasoning: usage.reduce((sum, event) => sum + (event.reasoningTokens ?? 0), 0),
  };
  const total = totals.input + totals.output + totals.reasoning;
  if (!total) return null;
  // The last step's prompt is what the model is currently holding in its context window.
  const last = usage.at(-1);
  const held = (last?.inputTokens ?? 0) + (last?.outputTokens ?? 0);
  const contextShare =
    contextWindow && contextWindow > 0 ? Math.min(1, held / contextWindow) : undefined;
  const exact = usageSegments
    .filter((segment) => totals[segment.key] > 0)
    .map((segment) => `${totals[segment.key].toLocaleString()} ${segment.label}`)
    .join(' · ');
  return (
    <div className="space-y-1.5" aria-label={`Token usage: ${exact}`}>
      <div className="flex items-center gap-3">
        <div
          className="flex h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-muted"
          title={exact}
        >
          {usageSegments.map((segment) =>
            totals[segment.key] > 0 ? (
              <span
                key={segment.key}
                className="h-full"
                style={{
                  width: `${String((totals[segment.key] / total) * 100)}%`,
                  background: segment.color,
                }}
              />
            ) : null,
          )}
        </div>
        <span className="shrink-0 text-meta tabular-nums text-text-2">
          {compactTokens(total)} tokens
        </span>
        {contextShare !== undefined && contextWindow ? (
          <span
            className="flex shrink-0 items-center gap-1.5 text-meta tabular-nums text-text-3"
            title={`${held.toLocaleString()} of ${contextWindow.toLocaleString()} context tokens`}
          >
            <span
              aria-hidden="true"
              className="inline-block size-3 rounded-full"
              style={{
                background: `conic-gradient(var(--ring) ${String(contextShare * 360)}deg, var(--muted) 0deg)`,
              }}
            />
            {`${String(Math.max(contextShare > 0 ? 1 : 0, Math.round(contextShare * 100)))}% of ${compactTokens(contextWindow)}`}
          </span>
        ) : null}
      </div>
      <div className="flex flex-wrap gap-x-3 gap-y-1 text-meta tabular-nums text-text-3">
        {usageSegments.map((segment) =>
          totals[segment.key] > 0 ? (
            <span key={segment.key} className="inline-flex items-center gap-1.5">
              <span
                aria-hidden="true"
                className="inline-block size-2 rounded-sm"
                style={{ background: segment.color }}
              />
              {segment.label} {totals[segment.key].toLocaleString()}
            </span>
          ) : null,
        )}
      </div>
    </div>
  );
}

function ThinkingEvent({ event }: { event: Extract<AgentEvent, { type: 'thinking' }> }) {
  const [open, setOpen] = useState(false);
  const summary = event.content.replace(/\s+/g, ' ').trim();
  const seconds = event.durationMs ? Math.max(1, Math.round(event.durationMs / 1000)) : null;
  return (
    <section className="rounded-xl border border-border-hair bg-card">
      <button
        aria-expanded={open}
        className={cn('flex w-full items-center gap-2 px-3 py-2 text-left', focusRingClass)}
        onClick={() => {
          setOpen((value) => !value);
        }}
        type="button"
      >
        {open ? (
          <ChevronDown aria-hidden="true" size={14} />
        ) : (
          <ChevronRight aria-hidden="true" size={14} />
        )}
        <span className="shrink-0 text-label font-medium text-text-2">
          {seconds ? `Thought for ${String(seconds)}s` : 'Thought'}
        </span>
        {summary ? (
          <span className="min-w-0 flex-1 truncate text-label text-text-3">{summary}</span>
        ) : null}
      </button>
      {open && (
        <p className="whitespace-pre-wrap px-3 pb-3 text-label leading-5 text-text-2">
          {event.content}
        </p>
      )}
    </section>
  );
}

function ToolStep({
  step,
  onShowFull,
}: {
  step: ToolTimelineStep;
  onShowFull?: (handle: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const duration = step.result?.durationMs ?? step.call.durationMs;
  const recoveryHandle = step.result?.recoveryHandle;
  return (
    <section className="overflow-hidden rounded-xl border border-border-hair bg-card">
      <button
        aria-expanded={open}
        className={cn('flex w-full items-center gap-2 px-3 py-2 text-left', focusRingClass)}
        onClick={() => {
          setOpen((value) => !value);
        }}
        type="button"
      >
        <Wrench aria-hidden="true" size={14} className="text-text-3" />
        <span className="min-w-0 flex-1 truncate text-label font-medium capitalize text-text-1">
          {prettyTool(step.call.tool)}
        </span>
        <span className="text-meta text-text-3">{step.result ? 'Done' : 'Running'}</span>
        {duration != null && (
          <span className="text-meta tabular-nums text-text-3">
            {(duration / 1000).toFixed(1)}s
          </span>
        )}
        {open ? (
          <ChevronDown aria-hidden="true" size={13} />
        ) : (
          <ChevronRight aria-hidden="true" size={13} />
        )}
      </button>
      {open && (
        <div className="space-y-2 border-t border-border-hair p-3">
          <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-input p-2 font-mono text-meta text-text-3">
            {JSON.stringify(step.call.input, null, 2)}
          </pre>
          {step.result && (
            <>
              <pre className="max-h-60 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-input p-2 font-mono text-meta text-text-2">
                {step.result.output}
              </pre>
              {step.result.truncated && recoveryHandle && (
                <button
                  className="text-meta text-link hover:underline"
                  onClick={() => {
                    onShowFull?.(recoveryHandle);
                  }}
                  type="button"
                >
                  Show full output
                </button>
              )}
            </>
          )}
        </div>
      )}
    </section>
  );
}

function ToolItem({
  item,
  onShowFull,
}: {
  item: TimelineToolItem;
  onShowFull?: (handle: string) => void;
}) {
  if ('call' in item) return <ToolStep step={item} {...(onShowFull ? { onShowFull } : {})} />;
  return (
    <details className="rounded-xl border border-border-hair bg-card">
      <summary
        className={cn('cursor-pointer px-3 py-2 text-label capitalize text-text-2', focusRingClass)}
      >
        {item.steps.length} {prettyTool(item.tool)} calls
      </summary>
      <div className="space-y-2 border-t border-border-hair p-2">
        {item.steps.map((step) => (
          <ToolStep key={step.call.id} step={step} {...(onShowFull ? { onShowFull } : {})} />
        ))}
      </div>
    </details>
  );
}

export function AgentTimeline({
  events,
  onShowFull,
  modelName,
  activity,
  startedAt,
  isRunning,
  runningToolTitle,
  currentStep: currentStepOverride,
  contextWindow,
  report,
  waitingForApproval = false,
}: {
  events: readonly AgentEvent[];
  report?: RunReport | undefined;
  onShowFull?: (handle: string) => void;
  modelName?: string;
  /** Context window of the model that answered, for the "4% of 128k" meter. */
  contextWindow?: number | undefined;
  activity?: ReactNode;
  startedAt?: string;
  isRunning?: boolean;
  runningToolTitle?: string | null;
  currentStep?: string | null;
  /** A pending approval is holding the run; say so instead of counting up. */
  waitingForApproval?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const lanes = buildTimelineLanes(events);
  const lastStatus = [...events].reverse().find((event) => event.type === 'status');
  const running = isRunning ?? (lastStatus?.type === 'status' && lastStatus.status === 'running');
  const completedCalls = new Set(
    events.filter((event) => event.type === 'tool_result').map((event) => event.callId),
  );
  const activeTool = [...events]
    .reverse()
    .find((event) => event.type === 'tool_use' && !completedCalls.has(event.callId));
  useEffect(() => {
    if (!running) return;
    const interval = window.setInterval(() => {
      setNow(Date.now());
    }, 1000);
    return () => {
      window.clearInterval(interval);
    };
  }, [running]);
  if (!events.length && Children.count(activity) === 0 && !modelName && !report) return null;
  const firstTime = events[0] ? Date.parse(events[0].timestamp) : 0;
  const lastEvent = events.at(-1);
  const lastTime = lastEvent ? Date.parse(lastEvent.timestamp) : firstTime;
  const durationMs =
    events.reduce((duration, event) => Math.max(duration, event.durationMs ?? 0), 0) ||
    Math.max(0, lastTime - firstTime);
  const lastCompletedRunIndex = events.reduce(
    (lastIndex, event, index) =>
      event.type === 'status' && event.status !== 'running' ? index : lastIndex,
    -1,
  );
  const currentRunStart = events
    .slice(lastCompletedRunIndex + 1)
    .find((event) => Number.isFinite(Date.parse(event.timestamp)));
  const startedAtMs = currentRunStart
    ? Date.parse(currentRunStart.timestamp)
    : startedAt
      ? Date.parse(startedAt)
      : firstTime;
  const elapsedMs = running ? Math.max(0, now - startedAtMs) : (report?.durationMs ?? durationMs);
  const elapsed =
    running && elapsedMs >= 3_600_000
      ? '>1h'
      : `${String(Math.max(1, Math.round(elapsedMs / 1000)))}s`;
  const activeToolStep =
    activeTool?.type === 'tool_use' &&
    ['bash', 'run_command', 'shell', 'terminal'].includes(activeTool.tool.toLowerCase())
      ? (() => {
          const input = activeTool.input;
          const command =
            input && typeof input === 'object' && 'command' in input ? String(input.command) : '';
          const shortName = command.trim().split(/\s+/).find(Boolean) ?? 'command';
          return `command: ${shortName}`;
        })()
      : activeTool?.type === 'tool_use'
        ? prettyTool(activeTool.tool)
        : null;
  const currentStep =
    lastStatus?.type === 'status' && lastStatus.status === 'waiting'
      ? lastStatus.message
      : activeTool
        ? (runningToolTitle ?? activeToolStep)
        : currentStepOverride;
  const liveLabel = waitingForApproval
    ? 'Waiting for your approval'
    : `Working… ${elapsed}${currentStep ? ` · ${currentStep}` : ''}`;
  const unavailable = lanes.model.some(
    (event) => event.type === 'status' && event.reasoningAvailable === false,
  );
  return (
    <section aria-label="Agent activity" className="space-y-2">
      <button
        aria-label={running ? liveLabel : `Worked for ${elapsed}`}
        aria-expanded={open}
        className={cn(
          'flex w-full items-center gap-2 text-left text-label text-text-3',
          focusRingClass,
        )}
        onClick={() => {
          setOpen((value) => !value);
        }}
        type="button"
      >
        {running && waitingForApproval ? (
          <CircleDot aria-hidden="true" className="text-warn" size={14} />
        ) : running ? (
          <LoaderCircle
            aria-hidden="true"
            className="animate-spin motion-reduce:animate-none"
            size={14}
          />
        ) : open ? (
          <ChevronDown aria-hidden="true" size={14} />
        ) : (
          <ChevronRight aria-hidden="true" size={14} />
        )}
        {running && waitingForApproval ? (
          <span className="text-text-2">Waiting for your approval</span>
        ) : (
          <>
            <span className="tabular-nums">
              {running ? `Working… ${elapsed}` : `Worked for ${elapsed}`}
            </span>
            {running && currentStep && (
              <span className="min-w-0 truncate text-text-2">· {currentStep}</span>
            )}
          </>
        )}
        {modelName && <span className="ml-auto text-meta text-text-3">{modelName}</span>}
      </button>
      {open && (
        <div className="space-y-2 pl-5 text-meta text-text-3">
          {report && (
            <div aria-label="Run report" className="space-y-1 break-words">
              {formatRunReport(report).map((line, index) => (
                <p key={index}>{line}</p>
              ))}
            </div>
          )}
          <div className="min-w-0 space-y-2">
            {unavailable && <p>This model doesn’t share its reasoning.</p>}
            {lanes.model.map((event) =>
              event.type === 'thinking' ? (
                <ThinkingEvent event={event} key={event.id} />
              ) : event.type === 'error' ? (
                <p className="text-label text-danger" key={event.id}>
                  {event.message}
                </p>
              ) : event.type === 'status' &&
                event.id === lastStatus?.id &&
                event.status !== 'completed' &&
                event.status !== 'running' &&
                event.reasoningAvailable !== false ? (
                // A normal finish needs no line; stops, pauses and limits still say why.
                <p className="text-meta text-text-3" key={event.id}>
                  {event.message ?? event.status}
                </p>
              ) : null,
            )}
          </div>
          {lanes.tools.map((item) => (
            <ToolItem
              item={item}
              key={
                'type' in item
                  ? `${item.tool}-${item.steps.at(0)?.call.id ?? 'group'}`
                  : item.call.id
              }
              {...(onShowFull ? { onShowFull } : {})}
            />
          ))}
          {activity}
          <UsageSummary events={events} contextWindow={contextWindow} />
        </div>
      )}
    </section>
  );
}

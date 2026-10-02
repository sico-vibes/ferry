import { useState } from 'react';
import { ChevronDown, ChevronRight, Wrench } from 'lucide-react';
import type { AgentEvent } from '@ferry/shared';
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

function countTokens(text: string): number {
  return text.trim() ? Math.ceil(text.trim().length / 4) : 0;
}
function prettyTool(tool: string): string {
  return tool.replace(/^mcp__/, '').replaceAll('_', ' ');
}
function ThinkingEvent({ event }: { event: Extract<AgentEvent, { type: 'thinking' }> }) {
  const [open, setOpen] = useState(false);
  const summary = event.content.replace(/\s+/g, ' ').trim();
  const length = event.content.length;
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
        <span className="min-w-0 flex-1 truncate text-label text-text-2">
          {summary || 'Thinking'}
        </span>
        <span className="shrink-0 text-meta tabular-nums text-text-3">
          {length} chars · ~{countTokens(event.content)} tokens
        </span>
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
}: {
  events: readonly AgentEvent[];
  onShowFull?: (handle: string) => void;
}) {
  if (!events.length) return null;
  const lanes = buildTimelineLanes(events);
  const unavailable = lanes.model.some(
    (event) => event.type === 'status' && event.reasoningAvailable === false,
  );
  return (
    <section
      aria-label="Agent timeline"
      className="grid gap-3 rounded-xl border border-border-hair bg-raised/40 p-3 md:grid-cols-2"
    >
      <div className="min-w-0 space-y-2">
        <h3 className="text-meta font-medium text-text-3">Model</h3>
        {unavailable && (
          <p className="text-meta text-text-3">This model doesn’t share its reasoning.</p>
        )}
        {lanes.model.map((event) =>
          event.type === 'thinking' ? (
            <ThinkingEvent event={event} key={event.id} />
          ) : event.type === 'text' ? (
            <p className="whitespace-pre-wrap text-label text-text-2" key={event.id}>
              {event.content}
            </p>
          ) : event.type === 'error' ? (
            <p className="text-label text-danger" key={event.id}>
              {event.message}
            </p>
          ) : event.type === 'status' && event.reasoningAvailable !== false ? (
            <p className="text-meta text-text-3" key={event.id}>
              {event.message ?? event.status}
            </p>
          ) : event.type === 'usage' ? (
            <p className="text-meta tabular-nums text-text-3" key={event.id}>
              Step usage: {String(event.inputTokens ?? 0)} in · {String(event.outputTokens ?? 0)}{' '}
              out
              {event.reasoningTokens ? ` · ${String(event.reasoningTokens)} reasoning` : ''} tokens
              {event.durationMs == null ? '' : ` · ${(event.durationMs / 1000).toFixed(1)}s`}
            </p>
          ) : null,
        )}
      </div>
      <div className="min-w-0 space-y-2">
        <h3 className="text-meta font-medium text-text-3">Tools</h3>
        {lanes.tools.map((item) => (
          <ToolItem
            item={item}
            key={
              'type' in item ? `${item.tool}-${item.steps.at(0)?.call.id ?? 'group'}` : item.call.id
            }
            {...(onShowFull ? { onShowFull } : {})}
          />
        ))}
        {!lanes.tools.length && <p className="text-meta text-text-3">No tool calls</p>}
      </div>
    </section>
  );
}

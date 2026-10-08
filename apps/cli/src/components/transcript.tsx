import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import type { MessagePart } from '@ferry/shared';
import { bad, blue, good, muted, renderMarkdown, warn } from '../format.js';

export interface TranscriptEntry {
  id: string;
  text?: string;
  role?: 'user' | 'assistant';
  part?: MessagePart;
  via?: string;
}

export function Transcript({
  entries,
  offset,
  enabled,
}: {
  entries: readonly TranscriptEntry[];
  offset: number;
  enabled: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  useInput((input, key) => {
    if (enabled && key.ctrl && input === 't') setExpanded((value) => !value);
  });
  // Default renders every entry for the terminal's own scrollback. Paging moves the end point.
  return (
    <Box flexDirection="column" marginY={1}>
      {entries.slice(0, Math.max(0, entries.length - offset)).map((entry) => (
        <Box flexDirection="column" key={entry.id}>
          {entry.part ? (
            <Text>{describePart(entry.part, expanded)}</Text>
          ) : (
            <Text>
              {entry.role === 'assistant'
                ? renderMarkdown(entry.text ?? '')
                : entry.role === 'user'
                  ? `you: ${entry.text ?? ''}`
                  : entry.text}
            </Text>
          )}
          {entry.via ? <Text>{muted(`via ${entry.via}`)}</Text> : null}
        </Box>
      ))}
      {offset ? (
        <Text>
          {muted(
            `Scrollback · ${String(offset)} entries below · PageDown returns to the latest reply`,
          )}
        </Text>
      ) : null}
    </Box>
  );
}

export function describePart(part: MessagePart, expanded = false): string {
  if (part.type === 'tool_call')
    return `${part.status === 'succeeded' ? good('✓') : part.status === 'failed' ? bad('✗') : blue('◌')} ${part.title} · ${part.status} ${muted('[Ctrl+T details]')}${expanded ? `\n${JSON.stringify(part.args)}${part.output ? `\n${part.output.text}` : ''}` : ''}`;
  if (part.type === 'handoff_marker')
    return muted(`↪ Handoff ${part.from} → ${part.to}: ${part.explanation}`);
  if (part.type === 'checkpoint') return good(`◆ Checkpoint: ${part.label}`);
  if (part.type === 'delegation') return blue(`▣ Delegation run ${part.runId}`);
  if (part.type === 'error') return bad(`Error: ${part.message}`);
  if (part.type === 'approval_request') return warn(`Approval: ${part.summary} · ${part.state}`);
  if (part.type === 'text') return renderMarkdown(part.text);
  return '';
}

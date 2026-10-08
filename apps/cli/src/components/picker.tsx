import React, { useRef, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { blue, muted } from '../colors.js';

export interface PickerOption {
  value: string;
  label: string;
  description?: string;
  group?: string;
  free?: boolean;
}

export function filterOptions(options: readonly PickerOption[], query: string, freeOnly = false) {
  const needle = query.toLocaleLowerCase();
  return options.filter(
    (row) =>
      (!freeOnly || row.free !== false) &&
      `${row.label} ${row.description ?? ''} ${row.group ?? ''}`
        .toLocaleLowerCase()
        .includes(needle),
  );
}

export function Picker({
  title,
  options,
  onSelect,
  onClose,
  onQuery,
  freeOnly,
  onFreeOnly,
}: {
  title: string;
  options: readonly PickerOption[];
  onSelect: (value: string) => void;
  onClose: () => void;
  onQuery?: (query: string) => void;
  freeOnly?: boolean;
  onFreeOnly?: (value: boolean) => void;
}) {
  const [query, setQuery] = useState('');
  const [index, setIndex] = useState(0);
  const indexRef = useRef(0);
  const visible = filterOptions(options, query, freeOnly);
  const selected = Math.min(index, Math.max(0, visible.length - 1));
  useInput((input, key) => {
    const current = Math.min(indexRef.current, Math.max(0, visible.length - 1));
    if (key.escape) {
      onClose();
      return;
    }
    if (key.upArrow) {
      indexRef.current = Math.max(0, current - 1);
      setIndex(indexRef.current);
      return;
    }
    if (key.downArrow) {
      indexRef.current = Math.max(0, Math.min(visible.length - 1, current + 1));
      setIndex(indexRef.current);
      return;
    }
    if (key.tab && onFreeOnly) {
      onFreeOnly(!freeOnly);
      indexRef.current = 0;
      setIndex(0);
      return;
    }
    if (key.return || input === '\r' || input === '\n') {
      const row = visible[current];
      if (row) onSelect(row.value);
      return;
    }
    if (key.ctrl || key.meta || key.tab) return;
    const next =
      key.backspace || key.delete ? query.slice(0, -1) : query + input.replace(/[\r\n]/g, '');
    setQuery(next);
    indexRef.current = 0;
    setIndex(0);
    onQuery?.(next);
  });
  const start = Math.max(0, selected - 5);
  return (
    <Box flexDirection="column">
      <Text bold>{title}</Text>
      <Text>
        {muted(
          `Filter: ${query || 'type to search'}${onFreeOnly ? ` · Free-only ${freeOnly ? 'on' : 'off'} (Tab)` : ''}`,
        )}
      </Text>
      {visible.slice(start, start + 10).map((row, offset) => (
        <React.Fragment key={row.value}>
          {row.group && row.group !== visible[start + offset - 1]?.group ? (
            <Text>{muted(row.group)}</Text>
          ) : null}
          <Text>
            {selected === start + offset ? blue('› ') : '  '}
            {row.label}
            {row.description ? muted(` · ${row.description}`) : ''}
          </Text>
        </React.Fragment>
      ))}
      {!visible.length ? <Text>{muted('No matches. Change the filter or press Esc.')}</Text> : null}
      <Text>
        {muted(`${String(visible.length)} options · ↑/↓ navigate · Enter select · Esc close`)}
      </Text>
    </Box>
  );
}

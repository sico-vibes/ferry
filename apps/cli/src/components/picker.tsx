import React, { useRef, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { blue, muted } from '../colors.js';

export type PickerFilterMode = 'all' | 'free' | 'included';

export interface PickerOption {
  value: string;
  label: string;
  description?: string;
  group?: string;
  free?: boolean;
  /** Included-subscription capacity. Never presented as `free`. */
  included?: boolean;
  /** Always shown regardless of the active filter (e.g. Auto / No profile). */
  pinned?: boolean;
  /** Not selectable in this view; keep it visible with a reason instead of dropping it. */
  disabled?: boolean;
  reason?: string | null;
  selectable?: boolean;
}

export function filterOptions(
  options: readonly PickerOption[],
  query: string,
  freeOnly = false,
  mode?: PickerFilterMode,
) {
  const needle = query.toLocaleLowerCase();
  return options.filter((row) => {
    if (mode === 'free' && row.free !== true && row.pinned !== true) return false;
    if (mode === 'included' && row.included !== true && row.pinned !== true) return false;
    if (mode === undefined && freeOnly && row.free === false) return false;
    return `${row.label} ${row.description ?? ''} ${row.group ?? ''}`
      .toLocaleLowerCase()
      .includes(needle);
  });
}

export function filterModeLabel(mode: PickerFilterMode): string {
  return mode === 'free'
    ? 'Free'
    : mode === 'included'
      ? 'Included subscriptions'
      : 'All connected';
}

export function Picker({
  title,
  options,
  onSelect,
  onClose,
  onQuery,
  freeOnly,
  onFreeOnly,
  filter,
  onDisabled,
}: {
  title: string;
  options: readonly PickerOption[];
  onSelect: (value: string) => void;
  onClose: () => void;
  onQuery?: (query: string) => void;
  freeOnly?: boolean;
  onFreeOnly?: (value: boolean) => void;
  /** Three-way Free / Included / All filter used by the model picker. */
  filter?: { mode: PickerFilterMode; onChange: (mode: PickerFilterMode) => void };
  onDisabled?: (option: PickerOption) => void;
}) {
  const [query, setQuery] = useState('');
  const [index, setIndex] = useState(0);
  const indexRef = useRef(0);
  const mode = filter?.mode;
  const visible = filterOptions(options, query, freeOnly, mode);
  const selected = Math.min(index, Math.max(0, visible.length - 1));
  const cycle = (current: PickerFilterMode): PickerFilterMode =>
    current === 'free' ? 'included' : current === 'included' ? 'all' : 'free';
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
    if (key.tab && filter) {
      filter.onChange(cycle(filter.mode));
      indexRef.current = 0;
      setIndex(0);
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
      if (!row) return;
      if (row.disabled) {
        onDisabled?.(row);
        return;
      }
      onSelect(row.value);
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
  const filterHint = filter
    ? ` · ${filterModeLabel(filter.mode)} (Tab)`
    : onFreeOnly
      ? ` · Free-only ${freeOnly ? 'on' : 'off'} (Tab)`
      : '';
  return (
    <Box flexDirection="column">
      <Text bold>{title}</Text>
      <Text>{muted(`Filter: ${query || 'type to search'}${filterHint}`)}</Text>
      {visible.slice(start, start + 10).map((row, offset) => (
        <React.Fragment key={row.value}>
          {row.group && row.group !== visible[start + offset - 1]?.group ? (
            <Text>{muted(row.group)}</Text>
          ) : null}
          <Text>
            {selected === start + offset ? blue('› ') : '  '}
            {row.label}
            {row.disabled ? muted(' (unavailable)') : ''}
            {row.description ? muted(` · ${row.description}`) : ''}
          </Text>
        </React.Fragment>
      ))}
      {!visible.length ? <Text>{muted('No matches. Change the filter or press Esc.')}</Text> : null}
      <Text>
        {muted(
          `${String(visible.length)} options · ${filter || onFreeOnly ? 'Tab filter · ' : ''}↑/↓ navigate · Enter select · Esc close`,
        )}
      </Text>
    </Box>
  );
}

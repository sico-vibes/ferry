import React, { useRef, useState } from 'react';
import { Box, Text, useInput, usePaste } from 'ink';
import { blue, muted } from '../colors.js';
import { SLASH_COMMANDS } from '../slash.js';

export function commandMatches(value: string) {
  return value.startsWith('/') && !/\s/.test(value)
    ? SLASH_COMMANDS.filter((row) => row.name.startsWith(value.toLowerCase()))
    : [];
}

export function Composer({
  value,
  onChange,
  onSubmit,
  disabled = false,
  secret = false,
  files = [],
  onFile,
}: {
  value: string;
  onChange: (value: string) => void;
  onSubmit: (value: string) => void;
  disabled?: boolean;
  secret?: boolean;
  files?: { path: string; name: string }[];
  onFile?: (path: string) => void;
}) {
  const history = useRef<string[]>([]);
  const historyIndex = useRef(-1);
  const draft = useRef('');
  const [selection, setSelection] = useState(0);
  const selectionRef = useRef(0);
  const [dismissed, setDismissed] = useState(false);
  const commands = secret || dismissed ? [] : commandMatches(value);
  const mentioning = !secret && /(?:^|\s)@([^\s]*)$/.test(value);
  const choices = commands.length ? commands : mentioning && !dismissed ? files : [];
  const selected = Math.min(selection, Math.max(0, choices.length - 1));
  const change = (next: string) => {
    onChange(next);
    selectionRef.current = 0;
    setSelection(0);
    setDismissed(false);
  };
  const send = (text: string) => {
    if (!text.trim()) return;
    if (!secret) history.current.push(text);
    historyIndex.current = -1;
    draft.current = '';
    onSubmit(text);
    setDismissed(true);
  };
  usePaste(
    (text) => {
      change(value + text.replace(/\r\n?/g, '\n'));
    },
    { isActive: !disabled },
  );
  useInput((input, key) => {
    const current = Math.min(selectionRef.current, Math.max(0, choices.length - 1));
    if (disabled || (key.ctrl && input === 'c') || key.pageUp || key.pageDown) return;
    if (key.escape) {
      setDismissed(true);
      return;
    }
    if (choices.length && (key.upArrow || key.downArrow)) {
      selectionRef.current = Math.max(
        0,
        Math.min(choices.length - 1, current + (key.upArrow ? -1 : 1)),
      );
      setSelection(selectionRef.current);
      return;
    }
    if (key.tab && choices.length) {
      if (commands.length) change(commands[current]?.name ?? value);
      else {
        const file = files[current];
        if (file) {
          onFile?.(file.path);
          change(
            value.replace(
              /@[^\s]*$/,
              `@${/\s/.test(file.path) ? JSON.stringify(file.path) : file.path} `,
            ),
          );
        }
      }
      return;
    }
    if (key.upArrow || key.downArrow) {
      if (!history.current.length || secret) return;
      if (historyIndex.current < 0) {
        draft.current = value;
        historyIndex.current = history.current.length;
      }
      historyIndex.current = Math.max(
        0,
        Math.min(history.current.length, historyIndex.current + (key.upArrow ? -1 : 1)),
      );
      change(history.current[historyIndex.current] ?? draft.current);
      setDismissed(true);
      return;
    }
    if (key.return || input === '\r' || input === '\n') {
      if (key.shift || key.meta) {
        change(value + '\n');
        return;
      }
      if (
        choices.length &&
        commands.length &&
        !commands.some((row) => row.name === value.toLowerCase())
      ) {
        change(commands[current]?.name ?? value);
        return;
      }
      if (choices.length && mentioning) {
        const file = files[current];
        if (file) {
          onFile?.(file.path);
          change(
            value.replace(
              /@[^\s]*$/,
              `@${/\s/.test(file.path) ? JSON.stringify(file.path) : file.path} `,
            ),
          );
        }
        return;
      }
      send(value);
      return;
    }
    if (key.ctrl && input === 'u') {
      change('');
      return;
    }
    if (key.ctrl || key.meta || key.tab || key.leftArrow || key.rightArrow) return;
    if (key.backspace || key.delete) {
      change(value.slice(0, -1));
      return;
    }
    // A single trailing Enter in a fast terminal chunk is submission. Multiple lines are paste.
    const normalized = input.replace(/\r\n?/g, '\n');
    if (/^[^\n]+\n$/.test(normalized)) {
      send(value + normalized.slice(0, -1));
      return;
    }
    change(value + normalized);
  });
  return (
    <Box flexDirection="column">
      <Text>
        {blue('› ')}
        {secret ? '•'.repeat(value.length) : value}
        <Text inverse> </Text>
      </Text>
      {commands.slice(Math.max(0, selected - 4), selected + 6).map((row) => (
        <Text key={row.name}>
          {commands[selected] === row ? blue('› ') : '  '}
          {row.name}
          {muted(` · ${row.description}`)}
        </Text>
      ))}
      {mentioning && !dismissed
        ? files.slice(Math.max(0, selected - 4), selected + 6).map((file) => (
            <Text key={file.path}>
              {files[selected] === file ? blue('› ') : '  '}@{file.path}
            </Text>
          ))
        : null}
      <Text>{muted('Enter sends · Alt/Shift+Enter newline · ↑/↓ history · Tab completes')}</Text>
    </Box>
  );
}

import React, { useState } from 'react';
import { Box, Text } from 'ink';
import type { CliModelCapabilities, CliOption } from '@ferry/shared';
import { Picker, type PickerOption } from './picker.js';
import { cliEffortOptionRows, cliSpeedOptionRows, nativeCapMetadata } from '../cli-connections.js';
import { muted, warn } from '../colors.js';

/**
 * Per-conversation options for an opted-in native CLI model. Effort uses the raw tokens the CLI
 * advertises (bridge-unsupported tokens stay visible but disabled); speed only offers `fast` when
 * the model genuinely supports it. The panel never changes its own view optimistically: it awaits
 * the caller's persistence and shows a failure inline, so the status bar keeps the confirmed value.
 */
export function CliOptionsPanel({
  model,
  options,
  onChange,
  onClose,
}: {
  model: CliModelCapabilities;
  options: CliOption;
  onChange: (patch: Partial<CliOption>) => Promise<void>;
  onClose: () => void;
}) {
  const [field, setField] = useState<'' | 'effort' | 'speed'>('');
  const [message, setMessage] = useState('');
  const caps = nativeCapMetadata(model);
  const rows: PickerOption[] =
    field === 'effort'
      ? cliEffortOptionRows(model)
      : field === 'speed'
        ? cliSpeedOptionRows(model)
        : [
            ...(model.efforts.length
              ? [
                  {
                    value: 'effort',
                    label: `Effort: ${options.effort ?? 'Default (CLI)'}`,
                    description: model.efforts.join(', '),
                  },
                ]
              : []),
            {
              value: 'speed',
              label: `Speed: ${options.speed === 'fast' ? 'Fast' : 'Standard'}`,
              description: model.speeds.includes('fast')
                ? 'Fast is advertised by this CLI'
                : 'Fast is not advertised by this CLI',
            },
            { value: 'done', label: 'Done' },
          ];
  const commit = (patch: Partial<CliOption>) => {
    void onChange(patch)
      .then(() => {
        setField('');
        setMessage('');
      })
      .catch((error: unknown) => {
        setMessage(error instanceof Error ? error.message : 'Could not save the option.');
      });
  };
  return (
    <Box flexDirection="column">
      <Text bold>{`Options · ${model.name}`}</Text>
      {caps.contextWindow !== null ? (
        <Text>{muted(`Context window: ${caps.contextWindow.toLocaleString()}`)}</Text>
      ) : null}
      {message ? <Text>{warn(message)}</Text> : null}
      <Picker
        key={field}
        title={field ? `Options / ${field}` : 'Model options'}
        options={rows}
        onClose={
          field
            ? () => {
                setField('');
                setMessage('');
              }
            : onClose
        }
        onDisabled={(row) => {
          setMessage(`Unavailable: ${row.reason ?? row.label}`);
        }}
        onSelect={(value) => {
          if (!field) {
            if (value === 'done') onClose();
            else setField(value as 'effort' | 'speed');
            return;
          }
          if (field === 'effort') {
            commit({ effort: value === '' ? null : value });
            return;
          }
          commit({ speed: value === 'fast' ? 'fast' : 'standard' });
        }}
      />
    </Box>
  );
}

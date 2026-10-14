import { useState } from 'react';
import type { ModelInfo, Profile } from '@ferry/shared';

export function CliModelDefaults({
  models,
  defaults,
  disabled = false,
  onChange,
}: {
  models: readonly ModelInfo[];
  defaults: NonNullable<Profile['cliDefaults']>;
  disabled?: boolean;
  onChange: (value: NonNullable<Profile['cliDefaults']>) => void;
}) {
  const [selected, setSelected] = useState('');
  const cliModels = models.filter((model) => model.cliCapabilities);
  const model = cliModels.find((item) => item.ref === selected) ?? cliModels[0];
  const capabilities = model?.cliCapabilities;
  if (!model || !capabilities) return null;
  const options = defaults[model.ref] ?? { effort: null, speed: 'standard' as const };
  return (
    <div className="cli-model-defaults">
      <h4>CLI model defaults</h4>
      <p className="muted text-ui-meta">
        Conversation options override these defaults. Only controls reported by the installed client
        are available.
      </p>
      <label className="cli-options-field">
        <span>Model</span>
        <select
          aria-label="CLI default model"
          value={model.ref}
          disabled={disabled}
          onChange={(event) => {
            setSelected(event.target.value);
          }}
        >
          {cliModels.map((item) => (
            <option key={item.ref} value={item.ref}>
              {item.name}
            </option>
          ))}
        </select>
      </label>
      {capabilities.efforts.length > 0 && (
        <label className="cli-options-field">
          <span>Default reasoning effort</span>
          <select
            aria-label="Default CLI reasoning effort"
            value={options.effort ?? ''}
            disabled={disabled}
            onChange={(event) => {
              const effort = capabilities.efforts.find((item) => item === event.target.value);
              if (event.target.value && (!effort || capabilities.unsupportedEfforts?.[effort]))
                return;
              onChange({
                ...defaults,
                [model.ref]: {
                  ...options,
                  effort: effort ?? null,
                },
              });
            }}
          >
            <option
              value=""
              disabled={Boolean(
                capabilities.defaultEffort &&
                capabilities.unsupportedEfforts?.[capabilities.defaultEffort],
              )}
            >
              Client default{capabilities.defaultEffort ? ` · ${capabilities.defaultEffort}` : ''}
            </option>
            {options.effort && !capabilities.efforts.includes(options.effort) && (
              <option value={options.effort} disabled>
                Unavailable · {options.effort}
              </option>
            )}
            {capabilities.efforts.map((effort) => (
              <option
                key={effort}
                value={effort}
                disabled={Boolean(capabilities.unsupportedEfforts?.[effort])}
                title={capabilities.unsupportedEfforts?.[effort]}
              >
                {capabilities.unsupportedEfforts?.[effort] ? 'Unavailable · ' : ''}
                {effort}
              </option>
            ))}
          </select>
          {Object.entries(capabilities.unsupportedEfforts ?? {}).map(([effort, reason]) => (
            <small key={effort}>
              {effort}: {reason}
            </small>
          ))}
        </label>
      )}
      {(capabilities.speeds.includes('fast') || options.speed === 'fast') && (
        <label className="cli-options-field">
          <span>Default speed</span>
          <select
            aria-label="Default CLI speed"
            value={options.speed}
            disabled={disabled}
            onChange={(event) => {
              onChange({
                ...defaults,
                [model.ref]: {
                  ...options,
                  speed: event.target.value === 'fast' ? 'fast' : 'standard',
                },
              });
            }}
          >
            <option value="standard">Standard</option>
            <option value="fast" disabled={!capabilities.speeds.includes('fast')}>
              {capabilities.speeds.includes('fast')
                ? 'Fast · spending permissions apply'
                : 'Unavailable · Fast'}
            </option>
          </select>
        </label>
      )}
    </div>
  );
}

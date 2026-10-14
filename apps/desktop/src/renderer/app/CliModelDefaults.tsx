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
              onChange({
                ...defaults,
                [model.ref]: {
                  ...options,
                  effort: capabilities.efforts.find((item) => item === event.target.value) ?? null,
                },
              });
            }}
          >
            <option value="">
              Client default{capabilities.defaultEffort ? ` · ${capabilities.defaultEffort}` : ''}
            </option>
            {capabilities.efforts.map((effort) => (
              <option key={effort} value={effort}>
                {effort}
              </option>
            ))}
          </select>
        </label>
      )}
      {capabilities.speeds.includes('fast') && (
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
            <option value="fast">Fast · spending permissions apply</option>
          </select>
        </label>
      )}
    </div>
  );
}

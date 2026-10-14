import type { CliOption, ModelInfo } from '@ferry/shared';
import { UiV2 } from '@ferry/ui';
import { Popover } from 'radix-ui';
import { Brain, ChevronDown, Settings2 } from 'lucide-react';

const effortLabel = (value: string) =>
  value === 'xhigh' ? 'Extra high' : value.charAt(0).toUpperCase() + value.slice(1);

export function CliOptionsChip({
  model,
  value,
  open,
  onOpenChange,
  onChange,
  busy,
  error,
}: {
  model: ModelInfo;
  value: CliOption;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onChange: (options: CliOption) => void;
  busy: boolean;
  error: string;
}) {
  const capabilities = model.cliCapabilities;
  if (!capabilities) return null;
  return (
    <Popover.Root open={open} onOpenChange={onOpenChange}>
      <Popover.Trigger asChild>
        <button
          type="button"
          className="v2-composer-chip cli-options-chip"
          aria-label={`${model.name} CLI options`}
        >
          <Settings2 size={14} strokeWidth={1.75} aria-hidden="true" />
          <span>
            {value.effort ? effortLabel(value.effort) : 'Options'}
            {value.speed === 'fast' ? ' · Fast' : ''}
          </span>
          <ChevronDown size={12} strokeWidth={1.75} aria-hidden="true" />
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          align="start"
          className="ferry-ui cli-options-popover"
          aria-label={`${model.name} CLI options`}
          collisionPadding={16}
        >
          <strong>{model.name}</strong>
          <p className="cli-options-description">Options reported by the installed client.</p>
          {error && <p role="alert">{error}</p>}
          {capabilities.efforts.length ? (
            <label className="cli-options-field">
              <span>
                <Brain size={14} strokeWidth={1.75} aria-hidden="true" /> Reasoning effort
              </span>
              <select
                aria-label="CLI reasoning effort"
                value={value.effort ?? ''}
                disabled={busy}
                onChange={(event) => {
                  const effort = capabilities.efforts.find((item) => item === event.target.value);
                  if (event.target.value && (!effort || capabilities.unsupportedEfforts?.[effort]))
                    return;
                  onChange({ ...value, effort: effort ?? null });
                }}
              >
                <option
                  value=""
                  disabled={Boolean(
                    capabilities.defaultEffort &&
                    capabilities.unsupportedEfforts?.[capabilities.defaultEffort],
                  )}
                >
                  Client default
                  {capabilities.defaultEffort
                    ? ` · ${effortLabel(capabilities.defaultEffort)}`
                    : ''}
                </option>
                {value.effort && !capabilities.efforts.includes(value.effort) && (
                  <option value={value.effort} disabled>
                    Unavailable · {effortLabel(value.effort)}
                  </option>
                )}
                {capabilities.efforts.map((effort) => (
                  <option
                    value={effort}
                    key={effort}
                    disabled={Boolean(capabilities.unsupportedEfforts?.[effort])}
                    title={capabilities.unsupportedEfforts?.[effort]}
                  >
                    {capabilities.unsupportedEfforts?.[effort] ? 'Unavailable · ' : ''}
                    {effortLabel(effort)}
                  </option>
                ))}
              </select>
            </label>
          ) : (
            <p className="cli-options-description">
              This model does not expose a reasoning-effort control.
            </p>
          )}
          {Object.entries(capabilities.unsupportedEfforts ?? {}).map(([effort, reason]) => (
            <p className="cli-options-description" key={effort}>
              {effortLabel(effort)}: {reason}
            </p>
          ))}
          {capabilities.speeds.includes('fast') ? (
            <label className="cli-options-fast">
              <span>Fast mode</span>
              <UiV2.Switch
                checked={value.speed === 'fast'}
                disabled={busy}
                aria-label="CLI fast mode"
                onCheckedChange={(enabled) => {
                  onChange({ ...value, speed: enabled ? 'fast' : 'standard' });
                }}
              />
            </label>
          ) : (
            <p className="cli-options-description">
              Standard speed · Fast mode is not advertised by this client.
            </p>
          )}
          {value.speed === 'fast' && !capabilities.speeds.includes('fast') && (
            <div className="grid gap-2">
              <p className="cli-options-description" role="status">
                The saved Fast setting is unavailable for this model.
              </p>
              <UiV2.Button
                size="sm"
                variant="secondary"
                disabled={busy}
                onClick={() => {
                  onChange({ ...value, speed: 'standard' });
                }}
              >
                Use standard speed
              </UiV2.Button>
            </div>
          )}
          <p className="cli-options-description">
            Subscription and metered limits still apply. Separately billed options follow your
            spending permissions.
          </p>
          <UiV2.Button
            size="sm"
            variant="secondary"
            onClick={() => {
              onOpenChange(false);
            }}
          >
            Done
          </UiV2.Button>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

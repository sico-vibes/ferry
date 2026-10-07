import { Brain, Check, ChevronDown } from 'lucide-react';
import { UiV2 } from '@ferry/ui';
import type { Effort } from '@ferry/shared';

const {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} = UiV2;

const effortLabels: Record<Effort, string> = {
  minimal: 'Minimal',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'Extra high',
  max: 'Max',
};
const effortOrder: Effort[] = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

/**
 * Reasoning effort for the selected model, next to the model chip. Hidden when the model has no
 * effort control; "Default" sends nothing and leaves the provider's own default.
 */
export function EffortChip({
  efforts,
  value,
  onChange,
}: {
  efforts: readonly Effort[] | undefined;
  value: Effort | null | undefined;
  onChange: (effort: Effort | null) => void;
}) {
  if (!efforts?.length) return null;
  const options = effortOrder.filter((effort) => efforts.includes(effort));
  // A level the current model doesn't offer isn't sent, so show it as Default.
  const current = value && options.includes(value) ? value : null;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={`Reasoning effort: ${current ? effortLabels[current] : 'Default'}`}
          className="v2-composer-chip v2-effort-chip inline-flex items-center gap-1.5 rounded-pill px-2 py-1 text-body font-medium text-text-1 hover:bg-icon-circle"
        >
          <Brain aria-hidden="true" size={14} />
          <span>{current ? effortLabels[current] : 'Effort'}</span>
          <ChevronDown aria-hidden="true" size={12} />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="min-w-44">
        <DropdownMenuLabel>Reasoning effort</DropdownMenuLabel>
        <DropdownMenuItem
          onSelect={() => {
            onChange(null);
          }}
        >
          <span className="flex-1">Default</span>
          {current === null ? <Check aria-hidden="true" /> : null}
        </DropdownMenuItem>
        {options.map((effort) => (
          <DropdownMenuItem
            key={effort}
            onSelect={() => {
              onChange(effort);
            }}
          >
            <span className="flex-1">{effortLabels[effort]}</span>
            {current === effort ? <Check aria-hidden="true" /> : null}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

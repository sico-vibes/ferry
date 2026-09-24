import { useState, type ReactNode } from 'react';
import {
  Dialog as DialogPrimitive,
  DropdownMenu as MenuPrimitive,
  RadioGroup as RadioPrimitive,
  Select as SelectPrimitive,
  Slider as SliderPrimitive,
  Switch as SwitchPrimitive,
  Tabs as TabsPrimitive,
  Tooltip as TooltipPrimitive,
} from 'radix-ui';
import { Check, ChevronDown, Eye, EyeOff, X } from 'lucide-react';
import { cn } from '../../lib/cn';

const control =
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40 focus-visible:ring-offset-2 focus-visible:ring-offset-app disabled:pointer-events-none disabled:opacity-40';
const surface = 'border border-border-soft bg-panel text-text-1 shadow-[var(--highlight-top)]';

export function Dialog({
  open,
  onOpenChange,
  title,
  description,
  children,
  trigger,
  contentClassName,
}: {
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  title: string;
  description?: string;
  children: ReactNode;
  trigger?: ReactNode;
  contentClassName?: string;
}) {
  return (
    <DialogPrimitive.Root
      {...(open === undefined ? {} : { open })}
      {...(onOpenChange ? { onOpenChange } : {})}
    >
      {trigger ? <DialogPrimitive.Trigger asChild>{trigger}</DialogPrimitive.Trigger> : null}
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="ferry-overlay" />
        <DialogPrimitive.Content className={cn('ferry-dialog', surface, contentClassName)}>
          <header className="ferry-dialog-head">
            <div>
              <DialogPrimitive.Title className="ferry-dialog-title">{title}</DialogPrimitive.Title>
              {description ? (
                <DialogPrimitive.Description className="ferry-dialog-description">
                  {description}
                </DialogPrimitive.Description>
              ) : null}
            </div>
            <DialogPrimitive.Close aria-label="Close dialog" className={cn('ferry-close', control)}>
              <X size={16} />
            </DialogPrimitive.Close>
          </header>
          {children}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

export function Sheet(props: React.ComponentProps<typeof Dialog>) {
  return <Dialog {...props} contentClassName={cn('ferry-sheet-content', props.contentClassName)} />;
}

export function Tooltip({ children, content }: { children: ReactNode; content: ReactNode }) {
  return (
    <TooltipPrimitive.Provider delayDuration={400}>
      <TooltipPrimitive.Root>
        <TooltipPrimitive.Trigger asChild>{children}</TooltipPrimitive.Trigger>
        <TooltipPrimitive.Portal>
          <TooltipPrimitive.Content sideOffset={6} className="ferry-tooltip">
            {content}
            <TooltipPrimitive.Arrow className="fill-raised" />
          </TooltipPrimitive.Content>
        </TooltipPrimitive.Portal>
      </TooltipPrimitive.Root>
    </TooltipPrimitive.Provider>
  );
}

export function DropdownMenu({
  trigger,
  items,
}: {
  trigger: ReactNode;
  items: {
    label?: string;
    separator?: boolean;
    onSelect?: () => void;
    shortcut?: string;
    icon?: ReactNode;
    danger?: boolean;
  }[];
}) {
  return (
    <MenuPrimitive.Root>
      <MenuPrimitive.Trigger asChild>{trigger}</MenuPrimitive.Trigger>
      <MenuPrimitive.Portal>
        <MenuPrimitive.Content sideOffset={6} className={cn('ferry-menu', surface)}>
          {items.map((item, index) =>
            item.separator ? (
              <MenuPrimitive.Separator
                key={`separator-${String(index)}`}
                className="ferry-menu-separator"
              />
            ) : (
              <MenuPrimitive.Item
                key={item.label ?? `item-${String(index)}`}
                onSelect={() => item.onSelect?.()}
                className={cn('ferry-menu-item', control, item.danger && 'text-danger')}
              >
                <span className="ferry-menu-icon">{item.icon}</span>
                <span>{item.label}</span>
                {item.shortcut ? (
                  <span className="ferry-menu-shortcut">{item.shortcut}</span>
                ) : null}
              </MenuPrimitive.Item>
            ),
          )}
        </MenuPrimitive.Content>
      </MenuPrimitive.Portal>
    </MenuPrimitive.Root>
  );
}

export function Switch({
  checked,
  onCheckedChange,
  label,
  disabled,
}: {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  label?: string;
  disabled?: boolean;
}) {
  return (
    <SwitchPrimitive.Root
      aria-label={label}
      checked={checked}
      onCheckedChange={onCheckedChange}
      disabled={disabled}
      className={cn('ferry-switch', control)}
    >
      <SwitchPrimitive.Thumb className="ferry-switch-thumb" />
    </SwitchPrimitive.Root>
  );
}

export function Select({
  value,
  onValueChange,
  options,
  label,
  placeholder,
}: {
  value: string;
  onValueChange: (value: string) => void;
  options: { value: string; label: string }[];
  label?: string;
  placeholder?: string;
}) {
  return (
    <SelectPrimitive.Root {...(value ? { value } : {})} onValueChange={onValueChange}>
      <SelectPrimitive.Trigger aria-label={label} className={cn('ferry-select-trigger', control)}>
        <SelectPrimitive.Value placeholder={placeholder ?? 'Choose'} />
        <SelectPrimitive.Icon>
          <ChevronDown size={14} />
        </SelectPrimitive.Icon>
      </SelectPrimitive.Trigger>
      <SelectPrimitive.Portal>
        <SelectPrimitive.Content
          position="popper"
          sideOffset={5}
          className={cn('ferry-menu ferry-select-content', surface)}
        >
          <SelectPrimitive.Viewport>
            {options.map((option) => (
              <SelectPrimitive.Item
                className="ferry-menu-item"
                key={option.value}
                value={option.value}
              >
                <SelectPrimitive.ItemText>{option.label}</SelectPrimitive.ItemText>
                <SelectPrimitive.ItemIndicator>
                  <Check size={14} />
                </SelectPrimitive.ItemIndicator>
              </SelectPrimitive.Item>
            ))}
          </SelectPrimitive.Viewport>
        </SelectPrimitive.Content>
      </SelectPrimitive.Portal>
    </SelectPrimitive.Root>
  );
}

export function SegmentedControl({
  value,
  onValueChange,
  options,
  label,
}: {
  value: string;
  onValueChange: (value: string) => void;
  options: { value: string; label: string }[];
  label?: string;
}) {
  return (
    <div
      aria-label={label}
      className="ferry-segmented"
      role="radiogroup"
      onKeyDown={(event) => {
        if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
        event.preventDefault();
        const current = options.findIndex((option) => option.value === value);
        const next =
          event.key === 'Home'
            ? 0
            : event.key === 'End'
              ? options.length - 1
              : (current + (event.key === 'ArrowRight' ? 1 : -1) + options.length) % options.length;
        const option = options[next];
        if (option) {
          onValueChange(option.value);
          event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="radio"]')[next]?.focus();
        }
      }}
    >
      {options.map((option) => (
        <button
          type="button"
          key={option.value}
          aria-checked={value === option.value}
          role="radio"
          tabIndex={value === option.value ? 0 : -1}
          onClick={() => {
            onValueChange(option.value);
          }}
          className={cn('ferry-segment', control, value === option.value && 'is-active')}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

export function Tabs({
  value,
  onValueChange,
  tabs,
}: {
  value: string;
  onValueChange: (value: string) => void;
  tabs: { value: string; label: string }[];
}) {
  return (
    <TabsPrimitive.Root value={value} onValueChange={onValueChange}>
      <TabsPrimitive.List className="ferry-tabs">
        {tabs.map((tab) => (
          <TabsPrimitive.Trigger className="ferry-tab" key={tab.value} value={tab.value}>
            {tab.label}
          </TabsPrimitive.Trigger>
        ))}
      </TabsPrimitive.List>
    </TabsPrimitive.Root>
  );
}

export function TextField({
  label,
  value,
  onChange,
  helper,
  error,
  masked = false,
  placeholder,
  type = 'text',
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  helper?: string;
  error?: string;
  masked?: boolean;
  placeholder?: string;
  type?: string;
}) {
  const [shown, setShown] = useState(false);
  return (
    <label className="ferry-field">
      <span className="ferry-field-label">{label}</span>
      <span className="ferry-input-wrap">
        <input
          className={cn('ferry-input', control)}
          type={masked && !shown ? 'password' : type}
          value={value}
          placeholder={placeholder}
          onChange={(event) => {
            onChange(event.target.value);
          }}
          aria-invalid={Boolean(error)}
        />
        {masked ? (
          <button
            type="button"
            className="ferry-field-eye"
            aria-label={shown ? 'Hide value' : 'Show value'}
            onClick={() => {
              setShown(!shown);
            }}
          >
            {shown ? <EyeOff size={15} /> : <Eye size={15} />}
          </button>
        ) : null}
      </span>
      {error ? (
        <small className="ferry-field-error">{error}</small>
      ) : helper ? (
        <small className="ferry-field-helper">{helper}</small>
      ) : null}
    </label>
  );
}

export function Slider({
  value,
  onValueChange,
  min,
  max,
  step = 1,
  label,
}: {
  value: number;
  onValueChange: (value: number) => void;
  min: number;
  max: number;
  step?: number;
  label?: string;
}) {
  return (
    <SliderPrimitive.Root
      aria-label={label}
      className="ferry-slider"
      min={min}
      max={max}
      step={step}
      value={[value]}
      onValueChange={(next) => {
        const item = next[0];
        if (item !== undefined) onValueChange(item);
      }}
    >
      <SliderPrimitive.Track className="ferry-slider-track">
        <SliderPrimitive.Range className="ferry-slider-range" />
      </SliderPrimitive.Track>
      <SliderPrimitive.Thumb aria-label={label} className="ferry-slider-thumb" />
    </SliderPrimitive.Root>
  );
}

export function RadioCards({
  value,
  onValueChange,
  options,
  multi = false,
}: {
  value: string[] | string;
  onValueChange: (value: string[] | string) => void;
  options: {
    value: string;
    title: string;
    description?: string;
    badge?: string;
    action?: ReactNode;
  }[];
  multi?: boolean;
}) {
  const selected = Array.isArray(value) ? value : [value];
  const choose = (item: string) => {
    onValueChange(
      multi
        ? selected.includes(item)
          ? selected.filter((candidate) => candidate !== item)
          : [...selected, item]
        : item,
    );
  };
  return (
    <div className="ferry-radio-cards">
      {options.map((option) => (
        <button
          type="button"
          key={option.value}
          className={cn('ferry-radio-card', selected.includes(option.value) && 'is-selected')}
          aria-pressed={selected.includes(option.value)}
          onClick={() => {
            choose(option.value);
          }}
        >
          <span className="ferry-radio-check">
            {selected.includes(option.value) ? <Check size={13} /> : null}
          </span>
          <span className="ferry-radio-copy">
            <strong>{option.title}</strong>
            {option.description ? <small>{option.description}</small> : null}
          </span>
          {option.badge ? <span className="ferry-radio-badge">{option.badge}</span> : null}
          {option.action}
        </button>
      ))}
    </div>
  );
}

export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="ferry-kbd">{children}</kbd>;
}

export function Checkbox({
  checked,
  onCheckedChange,
  label,
}: {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  label: string;
}) {
  return (
    <label className="ferry-checkbox">
      <input
        type="checkbox"
        checked={checked}
        onChange={(event) => {
          onCheckedChange(event.target.checked);
        }}
      />
      <span>{label}</span>
    </label>
  );
}

export const RadioItem = RadioPrimitive.Item;

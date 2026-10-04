import { useEffect, useState } from 'react';
import { UiV2 } from '@ferry/ui';

export function TextPromptDialog({
  open,
  onOpenChange,
  title,
  description,
  label,
  placeholder,
  onSubmit,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: string;
  label: string;
  placeholder?: string;
  onSubmit: (value: string) => void;
}) {
  const [value, setValue] = useState('');
  useEffect(() => {
    if (open) setValue('');
  }, [open]);
  return (
    <UiV2.Dialog open={open} onOpenChange={onOpenChange}>
      <UiV2.DialogContent>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            const next = value.trim();
            if (next) onSubmit(next);
          }}
        >
          <UiV2.DialogHeader>
            <UiV2.DialogTitle>{title}</UiV2.DialogTitle>
            <UiV2.DialogDescription>{description}</UiV2.DialogDescription>
          </UiV2.DialogHeader>
          <UiV2.Input
            autoFocus
            aria-label={label}
            className="mt-4"
            placeholder={placeholder}
            value={value}
            onChange={(event) => {
              setValue(event.currentTarget.value);
            }}
          />
          <div className="mt-5 flex justify-end gap-2">
            <UiV2.Button
              variant="secondary"
              onClick={() => {
                onOpenChange(false);
              }}
            >
              Cancel
            </UiV2.Button>
            <UiV2.Button disabled={!value.trim()} type="submit">
              Continue
            </UiV2.Button>
          </div>
        </form>
      </UiV2.DialogContent>
    </UiV2.Dialog>
  );
}

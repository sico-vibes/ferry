import type { ReactNode } from 'react';
import { UiV2 } from '@ferry/ui';

export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel,
  onConfirm,
  destructive = false,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: string;
  confirmLabel: string;
  onConfirm: () => void;
  destructive?: boolean;
  children?: ReactNode;
}) {
  return (
    <UiV2.AlertDialog open={open} onOpenChange={onOpenChange}>
      <UiV2.AlertDialogContent>
        <div className="grid gap-2">
          <UiV2.AlertDialogTitle className="text-ui-section font-semibold">
            {title}
          </UiV2.AlertDialogTitle>
          <UiV2.AlertDialogDescription className="text-ui-body text-muted-foreground">
            {description}
          </UiV2.AlertDialogDescription>
          {children}
        </div>
        <div className="mt-6 flex justify-end gap-2">
          <UiV2.AlertDialogCancel asChild>
            <UiV2.Button variant="secondary">Cancel</UiV2.Button>
          </UiV2.AlertDialogCancel>
          <UiV2.AlertDialogAction asChild>
            <UiV2.Button variant={destructive ? 'destructive' : 'default'} onClick={onConfirm}>
              {confirmLabel}
            </UiV2.Button>
          </UiV2.AlertDialogAction>
        </div>
      </UiV2.AlertDialogContent>
    </UiV2.AlertDialog>
  );
}

import { lazy, Suspense, useEffect, useRef } from 'react';
import { useRouterState } from '@tanstack/react-router';
import { UiV2, Skeleton } from '@ferry/ui';
import { useUI } from '../state/ui';

const SettingsCanvas = lazy(() =>
  import('./SettingsCanvas').then((module) => ({ default: module.SettingsCanvas })),
);

/** Settings as a large centered dialog over the current page (deep link: /settings). */
export function SettingsDialog() {
  const open = useUI((state) => state.settingsOpen);
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const openedAt = useRef(pathname);
  useEffect(() => {
    // Anything inside Settings that navigates (Open Models, onboarding) leaves the dialog.
    if (open && pathname !== openedAt.current) useUI.getState().closeSettings();
    openedAt.current = pathname;
  }, [open, pathname]);
  return (
    <UiV2.Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) useUI.getState().closeSettings();
      }}
    >
      <UiV2.DialogContent aria-describedby={undefined} className="v2-settings-dialog">
        <UiV2.DialogTitle className="sr-only">Settings</UiV2.DialogTitle>
        <Suspense
          fallback={
            <div className="v2-settings-dialog-loading" role="status">
              <Skeleton rows={6} />
            </div>
          }
        >
          <SettingsCanvas />
        </Suspense>
      </UiV2.DialogContent>
    </UiV2.Dialog>
  );
}

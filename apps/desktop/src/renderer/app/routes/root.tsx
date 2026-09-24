import { createRootRoute, Outlet } from '@tanstack/react-router';
import { lazy, Suspense } from 'react';
import { Skeleton } from '@ferry/ui';

const AppFrame = lazy(() => import('../AppFrame').then((module) => ({ default: module.AppFrame })));

function RootFrame() {
  return (
    <Suspense
      fallback={
        <div className="p-6">
          <Skeleton rows={4} />
        </div>
      }
    >
      <AppFrame>
        <Outlet />
      </AppFrame>
    </Suspense>
  );
}

export const rootRoute = createRootRoute({
  component: RootFrame,
});

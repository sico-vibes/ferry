import { createRootRoute, Outlet } from '@tanstack/react-router';
import { AppFrame } from '../AppFrame';

function RootFrame() {
  return (
    <AppFrame>
      <Outlet />
    </AppFrame>
  );
}

export const rootRoute = createRootRoute({
  component: RootFrame,
});

import { createRootRoute, Outlet } from '@tanstack/react-router';
import { AppFrame } from '../AppFrame';

export const rootRoute = createRootRoute({
  component: () => (
    <AppFrame>
      <Outlet />
    </AppFrame>
  ),
});

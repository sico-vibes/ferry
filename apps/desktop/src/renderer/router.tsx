import {
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from '@tanstack/react-router';
import { AppFrame } from './app/AppFrame';
import { HomeCanvas, PlaceholderCanvas, SessionCanvas } from './app/Canvas';

const rootRoute = createRootRoute({
  component: () => (
    <AppFrame>
      <Outlet />
    </AppFrame>
  ),
});
const homeRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
  component: HomeCanvas,
});
const sessionRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/s/$sessionId',
  component: SessionCanvas,
});
const exploreRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/explore',
  component: () => <PlaceholderCanvas title="Explore" />,
});
const usageRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/explore/usage',
  component: () => <PlaceholderCanvas title="Usage" />,
});
const libraryRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/library',
  component: () => <PlaceholderCanvas title="Library" />,
});
const settingsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/settings',
  component: () => <PlaceholderCanvas title="Settings" />,
});
const routeTree = rootRoute.addChildren([
  homeRoute,
  sessionRoute,
  exploreRoute,
  usageRoute,
  libraryRoute,
  settingsRoute,
]);
const router = createRouter({ routeTree });

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}

export function AppRouter() {
  return <RouterProvider router={router} />;
}

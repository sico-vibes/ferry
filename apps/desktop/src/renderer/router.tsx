import {
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from '@tanstack/react-router';
import { AppFrame } from './app/AppFrame';
import { HomeCanvas, SessionCanvas } from './app/Canvas';
import { ExploreCanvas } from './app/explore/Explore';
import { UsageCanvas } from './app/explore/Usage';
import { LibraryCanvas } from './app/LibraryCanvas';
import { SettingsCanvas } from './app/SettingsCanvas';
import { OnboardingCanvas } from './app/OnboardingCanvas';
import { useSettings } from './data/queries';

function HomeRoute() {
  const { data: settings } = useSettings();
  return settings?.onboardingComplete === false ? <OnboardingCanvas /> : <HomeCanvas />;
}

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
  component: HomeRoute,
});
const sessionRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/s/$sessionId',
  component: SessionCanvas,
});
const exploreRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/explore',
  component: ExploreCanvas,
});
const usageRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/explore/usage',
  component: UsageCanvas,
});
const libraryRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/library',
  component: LibraryCanvas,
});
const settingsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/settings',
  component: SettingsCanvas,
});
const onboardingRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/onboarding',
  component: OnboardingCanvas,
});
const routeTree = rootRoute.addChildren([
  homeRoute,
  sessionRoute,
  exploreRoute,
  usageRoute,
  libraryRoute,
  settingsRoute,
  onboardingRoute,
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

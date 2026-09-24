import { createRoute } from '@tanstack/react-router';
import { lazy, Suspense } from 'react';
import { rootRoute } from './root';
import { RouteLoading } from './RouteLoading';

const SettingsCanvas = lazy(() =>
  import('../SettingsCanvas').then((module) => ({ default: module.SettingsCanvas })),
);
const OnboardingCanvas = lazy(() =>
  import('../OnboardingCanvas').then((module) => ({ default: module.OnboardingCanvas })),
);
const SettingsPage = () => (
  <Suspense fallback={<RouteLoading />}>
    <SettingsCanvas />
  </Suspense>
);
const OnboardingPage = () => (
  <Suspense fallback={<RouteLoading />}>
    <OnboardingCanvas />
  </Suspense>
);

export const settingsRoutes = [
  createRoute({ getParentRoute: () => rootRoute, path: '/settings', component: SettingsPage }),
  createRoute({
    getParentRoute: () => rootRoute,
    path: '/onboarding',
    component: OnboardingPage,
  }),
] as const;

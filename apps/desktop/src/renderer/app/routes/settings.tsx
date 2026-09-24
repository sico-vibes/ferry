import { createRoute } from '@tanstack/react-router';
import { SettingsCanvas } from '../SettingsCanvas';
import { OnboardingCanvas } from '../OnboardingCanvas';
import { rootRoute } from './root';

export const settingsRoutes = [
  createRoute({ getParentRoute: () => rootRoute, path: '/settings', component: SettingsCanvas }),
  createRoute({
    getParentRoute: () => rootRoute,
    path: '/onboarding',
    component: OnboardingCanvas,
  }),
] as const;

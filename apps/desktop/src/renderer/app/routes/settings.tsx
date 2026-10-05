import { createRoute, useNavigate } from '@tanstack/react-router';
import { lazy, Suspense, useEffect } from 'react';
import { rootRoute } from './root';
import { RouteLoading } from './RouteLoading';
import { settingsSections, useUI } from '../../state/ui';

const OnboardingCanvas = lazy(() =>
  import('../OnboardingCanvas').then((module) => ({ default: module.OnboardingCanvas })),
);

/** Settings is a dialog; this deep link lands on Home and opens it (optionally at ?section=). */
function SettingsRedirect() {
  const navigate = useNavigate();
  useEffect(() => {
    const requested = new URLSearchParams(location.search).get('section');
    const section = settingsSections.find((name) => name === requested);
    void navigate({ to: '/', replace: true }).then(() => {
      useUI.getState().openSettings(section);
    });
  }, [navigate]);
  return <RouteLoading />;
}
const OnboardingPage = () => (
  <Suspense fallback={<RouteLoading />}>
    <OnboardingCanvas />
  </Suspense>
);

export const settingsRoutes = [
  createRoute({ getParentRoute: () => rootRoute, path: '/settings', component: SettingsRedirect }),
  createRoute({
    getParentRoute: () => rootRoute,
    path: '/onboarding',
    component: OnboardingPage,
  }),
] as const;

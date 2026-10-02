import { createRoute } from '@tanstack/react-router';
import { lazy, Suspense } from 'react';
import { useSettings } from '../../data/queries';
import { rootRoute } from './root';
import { RouteLoading } from './RouteLoading';

const HomeCanvas = lazy(() =>
  import('../Canvas').then((module) => ({ default: module.HomeCanvas })),
);
const OnboardingCanvas = lazy(() =>
  import('../OnboardingCanvas').then((module) => ({ default: module.OnboardingCanvas })),
);

function HomeRoute() {
  const { data: settings } = useSettings();
  if (!settings) return <RouteLoading />;
  return (
    <Suspense fallback={<RouteLoading />}>
      {!settings.onboardingComplete ? <OnboardingCanvas /> : <HomeCanvas />}
    </Suspense>
  );
}
export const homeRoutes = [
  createRoute({ getParentRoute: () => rootRoute, path: '/', component: HomeRoute }),
] as const;

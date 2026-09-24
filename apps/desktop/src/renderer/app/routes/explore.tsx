import { createRoute } from '@tanstack/react-router';
import { lazy, Suspense } from 'react';
import { rootRoute } from './root';
import { RouteLoading } from './RouteLoading';

const ExploreCanvas = lazy(() =>
  import('../explore/Explore').then((module) => ({ default: module.ExploreCanvas })),
);
const UsageCanvas = lazy(() =>
  import('../explore/Usage').then((module) => ({ default: module.UsageCanvas })),
);
const ExplorePage = () => (
  <Suspense fallback={<RouteLoading />}>
    <ExploreCanvas />
  </Suspense>
);
const UsagePage = () => (
  <Suspense fallback={<RouteLoading />}>
    <UsageCanvas />
  </Suspense>
);

export const exploreRoutes = [
  createRoute({ getParentRoute: () => rootRoute, path: '/explore', component: ExplorePage }),
  createRoute({ getParentRoute: () => rootRoute, path: '/explore/usage', component: UsagePage }),
] as const;

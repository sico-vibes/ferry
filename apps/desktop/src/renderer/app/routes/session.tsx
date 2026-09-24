import { createRoute } from '@tanstack/react-router';
import { lazy, Suspense } from 'react';
import { rootRoute } from './root';
import { RouteLoading } from './RouteLoading';

const SessionCanvas = lazy(() =>
  import('../Canvas').then((module) => ({ default: module.SessionCanvas })),
);
const ReviewCanvas = lazy(() =>
  import('../ReviewCanvas').then((module) => ({ default: module.ReviewCanvas })),
);
const SessionPage = () => (
  <Suspense fallback={<RouteLoading />}>
    <SessionCanvas />
  </Suspense>
);
const ReviewPage = () => (
  <Suspense fallback={<RouteLoading />}>
    <ReviewCanvas />
  </Suspense>
);

export const sessionRoutes = [
  createRoute({ getParentRoute: () => rootRoute, path: '/s/$sessionId', component: SessionPage }),
  createRoute({
    getParentRoute: () => rootRoute,
    path: '/s/$sessionId/review/$runId',
    component: ReviewPage,
  }),
] as const;

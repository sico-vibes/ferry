import { createRoute } from '@tanstack/react-router';
import { lazy, Suspense } from 'react';
import { rootRoute } from './root';
import { RouteLoading } from './RouteLoading';

const ModelsCanvas = lazy(() =>
  import('../explore/Explore').then((module) => ({ default: module.ModelsCanvas })),
);
const ModelsPage = () => (
  <Suspense fallback={<RouteLoading />}>
    <ModelsCanvas />
  </Suspense>
);

export const modelsRoutes = [
  createRoute({ getParentRoute: () => rootRoute, path: '/models', component: ModelsPage }),
  createRoute({ getParentRoute: () => rootRoute, path: '/models/catalog', component: ModelsPage }),
  createRoute({ getParentRoute: () => rootRoute, path: '/models/usage', component: ModelsPage }),
  createRoute({ getParentRoute: () => rootRoute, path: '/models/health', component: ModelsPage }),
] as const;

import { createRoute } from '@tanstack/react-router';
import { lazy, Suspense } from 'react';
import { rootRoute } from './root';
import { RouteLoading } from './RouteLoading';

const LibraryCanvas = lazy(() =>
  import('../LibraryCanvas').then((module) => ({ default: module.LibraryCanvas })),
);
const LibraryPage = () => (
  <Suspense fallback={<RouteLoading />}>
    <LibraryCanvas />
  </Suspense>
);

export const libraryRoutes = [
  createRoute({ getParentRoute: () => rootRoute, path: '/library', component: LibraryPage }),
] as const;

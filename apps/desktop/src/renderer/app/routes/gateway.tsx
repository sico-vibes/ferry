import { createRoute } from '@tanstack/react-router';
import { lazy, Suspense } from 'react';
import { rootRoute } from './root';
import { RouteLoading } from './RouteLoading';

const GatewayCanvas = lazy(() =>
  import('../gateway/GatewayCanvas').then((module) => ({ default: module.GatewayCanvas })),
);
const GatewayPage = () => (
  <Suspense fallback={<RouteLoading />}>
    <GatewayCanvas />
  </Suspense>
);

export const gatewayRoutes = [
  createRoute({ getParentRoute: () => rootRoute, path: '/gateway', component: GatewayPage }),
] as const;

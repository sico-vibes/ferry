import { createRoute, redirect } from '@tanstack/react-router';
import { rootRoute } from './root';

export const exploreRoutes = [
  createRoute({
    getParentRoute: () => rootRoute,
    path: '/explore',
    beforeLoad: () => redirect({ to: '/models' }),
  }),
  createRoute({
    getParentRoute: () => rootRoute,
    path: '/explore/usage',
    beforeLoad: () => redirect({ to: '/models/usage' }),
  }),
] as const;

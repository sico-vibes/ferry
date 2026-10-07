import { createRoute, redirect } from '@tanstack/react-router';
import { rootRoute } from './root';

// The Library page was replaced by Projects in the sidebar; old links land on Home.
export const libraryRoutes = [
  createRoute({
    getParentRoute: () => rootRoute,
    path: '/library',
    beforeLoad: () => redirect({ to: '/' }),
  }),
] as const;

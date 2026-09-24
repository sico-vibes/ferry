import { createRoute } from '@tanstack/react-router';
import { SessionCanvas } from '../Canvas';
import { ReviewCanvas } from '../ReviewCanvas';
import { rootRoute } from './root';

export const sessionRoutes = [
  createRoute({ getParentRoute: () => rootRoute, path: '/s/$sessionId', component: SessionCanvas }),
  createRoute({
    getParentRoute: () => rootRoute,
    path: '/s/$sessionId/review/$runId',
    component: ReviewCanvas,
  }),
] as const;

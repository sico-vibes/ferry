import { createRoute } from '@tanstack/react-router';
import { ExploreCanvas } from '../explore/Explore';
import { UsageCanvas } from '../explore/Usage';
import { rootRoute } from './root';

export const exploreRoutes = [
  createRoute({ getParentRoute: () => rootRoute, path: '/explore', component: ExploreCanvas }),
  createRoute({ getParentRoute: () => rootRoute, path: '/explore/usage', component: UsageCanvas }),
] as const;

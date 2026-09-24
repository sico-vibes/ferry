import { homeRoutes } from './home';
import { sessionRoutes } from './session';
import { exploreRoutes } from './explore';
import { libraryRoutes } from './library';
import { settingsRoutes } from './settings';
import { rootRoute } from './root';

export { rootRoute };
export const routeRegistry = [
  ...homeRoutes,
  ...sessionRoutes,
  ...exploreRoutes,
  ...libraryRoutes,
  ...settingsRoutes,
] as const;

import { homeRoutes } from './home';
import { sessionRoutes } from './session';
import { exploreRoutes } from './explore';
import { libraryRoutes } from './library';
import { settingsRoutes } from './settings';
import { rootRoute } from './root';
import { createRoute, useNavigate } from '@tanstack/react-router';
import { EmptyState } from '@ferry/ui';

function NotFoundCanvas() {
  const navigate = useNavigate();
  return (
    <section className="canvas">
      <EmptyState
        title="Page not found"
        action="Back to Home"
        onAction={() => void navigate({ to: '/' })}
      />
    </section>
  );
}

const notFoundRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/$',
  component: NotFoundCanvas,
});

export { rootRoute };
export const routeRegistry = [
  ...homeRoutes,
  ...sessionRoutes,
  ...exploreRoutes,
  ...libraryRoutes,
  ...settingsRoutes,
  notFoundRoute,
] as const;

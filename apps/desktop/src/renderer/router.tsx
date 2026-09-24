import { createRouter, RouterProvider } from '@tanstack/react-router';
import { rootRoute, routeRegistry } from './app/routes';

const routeTree = rootRoute.addChildren(routeRegistry);
const router = createRouter({ routeTree });

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}

export function AppRouter() {
  return <RouterProvider router={router} />;
}

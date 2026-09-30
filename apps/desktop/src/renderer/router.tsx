import { createHashHistory, createRouter, RouterProvider } from '@tanstack/react-router';
import { rootRoute, routeRegistry } from './app/routes';

const routeTree = rootRoute.addChildren(routeRegistry);
const router = createRouter({
  routeTree,
  ...(location.protocol === 'file:' ? { history: createHashHistory() } : {}),
});

if (import.meta.env.DEV && new URLSearchParams(location.search).has('perf-render'))
  window.ferryPerfNavigate = (path) => router.navigate({ to: path as never });

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}

export function AppRouter() {
  return <RouterProvider router={router} />;
}

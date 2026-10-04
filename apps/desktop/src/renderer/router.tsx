import { createHashHistory, createRouter, RouterProvider } from '@tanstack/react-router';
import { rootRoute, routeRegistry } from './app/routes';

const previewUrl = new URL(window.location.href);
const requestedPreviewRoute = previewUrl.searchParams.get('route');
if (import.meta.env.DEV && requestedPreviewRoute?.startsWith('/')) {
  previewUrl.searchParams.delete('route');
  previewUrl.pathname = requestedPreviewRoute;
  window.history.replaceState(null, '', previewUrl);
}
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

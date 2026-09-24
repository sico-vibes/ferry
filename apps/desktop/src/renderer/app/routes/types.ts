import type { AnyRoute } from '@tanstack/react-router';

export type RouteFragment = (parent: () => AnyRoute) => readonly AnyRoute[];

import { createRoute } from '@tanstack/react-router';
import { LibraryCanvas } from '../LibraryCanvas';
import { rootRoute } from './root';

export const libraryRoutes = [
  createRoute({ getParentRoute: () => rootRoute, path: '/library', component: LibraryCanvas }),
] as const;

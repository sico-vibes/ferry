import { createRoute } from '@tanstack/react-router';
import { HomeCanvas } from '../Canvas';
import { OnboardingCanvas } from '../OnboardingCanvas';
import { useSettings } from '../../data/queries';
import { rootRoute } from './root';

function HomeRoute() {
  const { data: settings } = useSettings();
  return settings?.onboardingComplete === false ? <OnboardingCanvas /> : <HomeCanvas />;
}
export const homeRoutes = [
  createRoute({ getParentRoute: () => rootRoute, path: '/', component: HomeRoute }),
] as const;

import { ResetsTimeline } from './ResetsTimeline';
import type { CapacitySummary } from '@ferry/shared';
const summary: CapacitySummary = {
  stepsLeftToday: 420,
  percentRemaining: 64,
  lowCapacity: false,
  perProvider: [],
  nextResets: [
    {
      providerId: 'gemini' as CapacitySummary['nextResets'][number]['providerId'],
      windowId: 'gemini-daily',
      label: 'per day',
      at: new Date(Date.now() + 2 * 60 * 60_000).toISOString(),
    },
  ],
  banner: null,
  updatedAt: new Date().toISOString(),
};
export default { title: 'Charts/ResetsTimeline' };
export const Upcoming = () => (
  <div className="w-96 bg-canvas p-4">
    <ResetsTimeline summary={summary} providerNames={{ gemini: 'Gemini API' }} />
  </div>
);

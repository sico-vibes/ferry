import { CanvasPanel, Skeleton, SkeletonRows, SkeletonChart, SkeletonStat, UiV2 } from '@ferry/ui';

export function RouteLoading() {
  return (
    <div className="w-full p-6">
      <Skeleton rows={3} />
    </div>
  );
}

/** Home waits for settings before deciding between the composer and onboarding. */
export function HomeLoading() {
  return (
    <CanvasPanel className="home-canvas v2-home-canvas">
      <div className="v2-home-layout">
        <div className="v2-home-greeting">
          <UiV2.Skeleton aria-hidden="true" className="h-8 w-48" />
        </div>
        <div aria-busy="true" role="status" className="w-full">
          <span className="sr-only">Loading</span>
          <UiV2.Skeleton aria-hidden="true" className="h-32 w-full" />
        </div>
        <section className="v2-home-stats" aria-label="Usage summary">
          <div className="v2-home-stat">
            <header>Activity</header>
            <SkeletonChart />
          </div>
          <div className="v2-home-stat">
            <header>Usage</header>
            <SkeletonStat />
            <SkeletonRows rows={2} />
          </div>
          <div className="v2-home-stat">
            <header>Top providers</header>
            <SkeletonRows rows={3} />
          </div>
        </section>
      </div>
    </CanvasPanel>
  );
}

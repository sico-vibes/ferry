import { Skeleton } from '@ferry/ui';

export function RouteLoading() {
  return (
    <div className="p-6">
      <Skeleton rows={3} />
    </div>
  );
}

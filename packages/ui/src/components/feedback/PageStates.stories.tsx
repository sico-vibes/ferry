import { EmptyState, ErrorState, Skeleton } from './PageStates';

export default { title: 'Feedback/Page states' };
export const EmptyLoadingError = () => (
  <div className="grid min-h-96 gap-5 bg-canvas p-8 md:grid-cols-3">
    <EmptyState title="No sessions yet" action="Start a chat" />
    <Skeleton rows={4} />
    <ErrorState title="Provider probe failed" action="Retry" />
  </div>
);

import { useId, type ReactNode } from 'react';
import { Skeleton as UiSkeleton } from '../ui';
import { AlertTriangle, ArrowRight, Inbox } from 'lucide-react';

export function EmptyState({
  title,
  action,
  onAction,
  icon,
}: {
  title: string;
  action: string;
  onAction?: () => void;
  icon?: ReactNode;
}) {
  return (
    <div className="page-state empty-state" role="status">
      <span className="page-state-illustration" aria-hidden="true">
        {icon ?? <Inbox size={22} />}
      </span>
      <p>{title}</p>
      {onAction ? (
        <button onClick={onAction}>
          {action}
          <ArrowRight size={14} />
        </button>
      ) : (
        <span className="page-state-cta">{action}</span>
      )}
    </div>
  );
}

export function ErrorState({
  title,
  action,
  onAction,
}: {
  title: string;
  action: string;
  onAction?: () => void;
}) {
  return (
    <div className="page-state error-state" role="alert">
      <span className="page-state-illustration" aria-hidden="true">
        <AlertTriangle size={20} />
      </span>
      <p>{title}</p>
      {onAction && (
        <button onClick={onAction}>
          {action}
          <ArrowRight size={14} />
        </button>
      )}
    </div>
  );
}

function LoadingRegion({ children, className = '' }: { children: ReactNode; className?: string }) {
  const id = useId();
  return (
    <div aria-busy="true" role="status" aria-labelledby={id} className={className}>
      <span id={id} className="sr-only">
        Loading
      </span>
      {children}
    </div>
  );
}

/** Content-shaped loading placeholders. One announcement per loading region. */
export function Skeleton({ rows = 3 }: { rows?: number }) {
  return <SkeletonRows rows={rows} />;
}
export function SkeletonRows({ rows = 3 }: { rows?: number }) {
  return (
    <LoadingRegion className="skeleton-stack">
      {Array.from({ length: rows }, (_, index) => (
        <div aria-hidden="true" className="ferry-skeleton-content-row" key={index}>
          <UiSkeleton className="ferry-skeleton-avatar" />
          <div className="ferry-skeleton-copy">
            <UiSkeleton />
            <UiSkeleton className="ferry-skeleton-helper" />
          </div>
          <UiSkeleton className="ferry-skeleton-control" />
        </div>
      ))}
    </LoadingRegion>
  );
}
export function SkeletonTable({ rows = 5, columns = 4 }: { rows?: number; columns?: number }) {
  return (
    <LoadingRegion className="skeleton-stack">
      {Array.from({ length: rows }, (_, row) => (
        <div
          aria-hidden="true"
          className="ferry-skeleton-table-row"
          style={{ gridTemplateColumns: `repeat(${String(columns)}, minmax(0, 1fr))` }}
          key={row}
        >
          {Array.from({ length: columns }, (_, column) => (
            <UiSkeleton key={column} />
          ))}
        </div>
      ))}
    </LoadingRegion>
  );
}
export function SkeletonStat() {
  return (
    <LoadingRegion>
      <UiSkeleton aria-hidden="true" className="ferry-skeleton-stat" />
    </LoadingRegion>
  );
}
export function SkeletonChart() {
  return (
    <LoadingRegion>
      <UiSkeleton aria-hidden="true" className="ferry-skeleton-chart" />
    </LoadingRegion>
  );
}

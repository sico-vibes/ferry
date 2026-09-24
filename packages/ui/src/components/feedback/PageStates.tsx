import type { ReactNode } from 'react';
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

export function Skeleton({ rows = 3 }: { rows?: number }) {
  return (
    <div aria-label="Loading" className="skeleton-stack" role="status">
      {Array.from({ length: rows }, (_, index) => (
        <span className="skeleton-row" key={index} />
      ))}
    </div>
  );
}

import type { ReactNode } from 'react';

export interface PageHeaderProps {
  title: string;
  level?: 1 | 2 | 3 | 4 | 5 | 6;
  subtitle?: string;
  primaryAction?: ReactNode;
  className?: string;
}

export function PageHeader({
  title,
  level = 1,
  subtitle,
  primaryAction,
  className = '',
}: PageHeaderProps) {
  const Heading = ({ 1: 'h1', 2: 'h2', 3: 'h3', 4: 'h4', 5: 'h5', 6: 'h6' } as const)[level];
  return (
    <header className={`ferry-page-header ${className}`.trim()}>
      <div className="ferry-page-header-main">
        <Heading className="ferry-page-header-title">{title}</Heading>
        {subtitle && <p>{subtitle}</p>}
      </div>
      {primaryAction && <div className="ferry-page-header-action">{primaryAction}</div>}
    </header>
  );
}

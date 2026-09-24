import type { ReactNode } from 'react';

export interface PageHeaderProps {
  title: string;
  subtitle?: string;
  eyebrow?: string;
  actions?: ReactNode;
  nav?: ReactNode;
  className?: string;
}

export function PageHeader({
  title,
  subtitle,
  eyebrow,
  actions,
  nav,
  className = '',
}: PageHeaderProps) {
  return (
    <header className={`ferry-page-header ${className}`.trim()}>
      <div className="ferry-page-header-main">
        {eyebrow && <span className="ferry-page-header-eyebrow">{eyebrow}</span>}
        <h1>{title}</h1>
        {subtitle && <p>{subtitle}</p>}
        {nav && <nav className="ferry-page-header-nav">{nav}</nav>}
      </div>
      {actions && <div className="ferry-page-header-actions">{actions}</div>}
    </header>
  );
}

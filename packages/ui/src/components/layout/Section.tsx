import { useId, type ReactNode } from 'react';

export interface SectionProps {
  title?: string;
  children: ReactNode;
  className?: string;
  ariaLabel?: string;
}

export function Section({ title, children, className = '', ariaLabel }: SectionProps) {
  const titleId = useId();
  return (
    <section
      aria-label={ariaLabel}
      aria-labelledby={title ? titleId : undefined}
      className={`ferry-section ${className}`.trim()}
    >
      {title && (
        <h2 className="ferry-section-title" id={titleId}>
          {title}
        </h2>
      )}
      {children}
    </section>
  );
}

import { useId, type ReactNode } from 'react';

export interface SectionProps {
  title?: string;
  children: ReactNode;
  className?: string;
  ariaLabel?: string;
  level?: 2 | 3;
}

export function Section({ title, children, className = '', ariaLabel, level = 2 }: SectionProps) {
  const titleId = useId();
  const Title = level === 3 ? 'h3' : 'h2';
  return (
    <section
      aria-label={ariaLabel}
      aria-labelledby={title ? titleId : undefined}
      className={`ferry-section ${className}`.trim()}
    >
      {title && (
        <Title className="ferry-section-title" id={titleId}>
          {title}
        </Title>
      )}
      {children}
    </section>
  );
}

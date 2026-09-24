import type { LayoutProps } from './Stack';

export function Cluster({ children, gap = 3, className = '' }: LayoutProps) {
  return (
    <div className={`ferry-cluster ferry-gap-${String(gap)} ${className}`.trim()}>{children}</div>
  );
}

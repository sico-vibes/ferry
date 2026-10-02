import { useState, type ReactNode } from 'react';

function readCount(key: string, initialCount: number): number {
  if (typeof sessionStorage === 'undefined') return initialCount;
  const stored = Number(sessionStorage.getItem(`ferry:list:${key}`));
  return Number.isFinite(stored) && stored >= initialCount ? stored : initialCount;
}

export function ShowMoreList<T>({
  items,
  groupKey,
  renderItem,
  initialCount = 6,
  increment = 6,
  label = 'items',
  moreLabel = label,
  listClassName = 'grid gap-1',
  ariaLabel,
  renderList,
  forceExpand = false,
}: {
  items: readonly T[];
  groupKey: string;
  renderItem: (item: T, index: number) => ReactNode;
  initialCount?: number;
  increment?: number;
  label?: string;
  moreLabel?: string;
  listClassName?: string;
  ariaLabel?: string;
  renderList?: (children: ReactNode[]) => ReactNode;
  forceExpand?: boolean;
}) {
  const [count, setCount] = useState(() => readCount(groupKey, initialCount));
  const visibleLimit = Math.min(forceExpand ? Math.max(count, 100) : count, items.length);
  const pageStart = Math.floor(Math.max(0, visibleLimit - 1) / 100) * 100;
  const visibleCount = Math.max(
    0,
    Math.min(visibleLimit - pageStart, 100, items.length - pageStart),
  );
  const visibleItems = items.slice(pageStart, pageStart + visibleCount);
  const updateCount = (next: number) => {
    setCount(next);
    if (typeof sessionStorage !== 'undefined')
      sessionStorage.setItem(`ferry:list:${groupKey}`, String(next));
  };
  return (
    <>
      {renderList ? (
        renderList(visibleItems.map((item, index) => renderItem(item, index + pageStart)))
      ) : (
        <ul aria-label={ariaLabel} className={listClassName}>
          {visibleItems.map((item, index) => renderItem(item, index + pageStart))}
        </ul>
      )}
      {items.length > initialCount && (
        <div className="mt-1 flex gap-3">
          {pageStart + visibleCount < items.length && (
            <button
              className="text-ui-meta text-accent-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              onClick={() => {
                updateCount(
                  visibleLimit >= pageStart + 100
                    ? pageStart + 100 + increment
                    : Math.min(pageStart + 100, count + increment),
                );
              }}
              type="button"
            >
              Show more {moreLabel} ({String(items.length - pageStart - visibleCount)})
            </button>
          )}
          {visibleLimit > initialCount && (
            <button
              className="text-ui-meta text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              onClick={() => {
                updateCount(initialCount);
              }}
              type="button"
            >
              Show less
            </button>
          )}
        </div>
      )}
    </>
  );
}

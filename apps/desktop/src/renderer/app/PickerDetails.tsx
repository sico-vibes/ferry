import { useEffect, useState, type ReactNode } from 'react';
import { Tooltip } from 'radix-ui';

/** Radix handles viewport collisions; smaller windows keep details inside the menu. */
export function PickerDetails({ children }: { children: ReactNode }) {
  const [inline, setInline] = useState(() => window.innerWidth < 800);
  useEffect(() => {
    const change = () => {
      setInline(window.innerWidth < 800);
    };
    window.addEventListener('resize', change);
    change();
    return () => {
      window.removeEventListener('resize', change);
    };
  }, []);
  if (!children) return null;
  if (inline) return <div className="model-picker-inline-details">{children}</div>;
  return (
    <Tooltip.Provider>
      <Tooltip.Root open>
        <Tooltip.Trigger asChild>
          <span className="model-picker-details-anchor" aria-hidden="true" />
        </Tooltip.Trigger>
        <Tooltip.Portal>
          <Tooltip.Content
            className="ferry-ui model-picker-floating-details"
            side="right"
            align="start"
            sideOffset={8}
            collisionPadding={{ top: 56, bottom: 16, left: 16, right: 16 }}
          >
            {children}
          </Tooltip.Content>
        </Tooltip.Portal>
      </Tooltip.Root>
    </Tooltip.Provider>
  );
}

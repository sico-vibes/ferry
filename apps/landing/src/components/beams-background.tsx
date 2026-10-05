'use client';

import dynamic from 'next/dynamic';
import { Component, useEffect, useRef, useState, type ReactNode } from 'react';

const Beams = dynamic(() => import('./beams').then((mod) => mod.Beams), { ssr: false });

interface Palette {
  beam: string;
  light: string;
  background: string;
}

function readPalette(): Palette | null {
  const style = getComputedStyle(document.documentElement);
  const beam = style.getPropertyValue('--beam').trim();
  const light = style.getPropertyValue('--beam-light').trim();
  const background = style.getPropertyValue('--background').trim();
  if (!beam || !light || !background) return null;
  return { beam, light, background };
}

class BeamsErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  override state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  override render() {
    if (this.state.failed) return null;
    return this.props.children;
  }
}

export function BeamsBackground() {
  const rootRef = useRef<HTMLDivElement>(null);
  const [palette, setPalette] = useState<Palette | null>(null);
  const [reduced, setReduced] = useState(true);
  const [compact, setCompact] = useState(false);
  const [active, setActive] = useState(false);

  useEffect(() => {
    const motion = window.matchMedia('(prefers-reduced-motion: reduce)');
    const compactQuery = window.matchMedia('(max-width: 768px)');
    const visible = { current: !document.hidden };
    const onScreen = { current: true };

    const publish = () => {
      setActive(visible.current && onScreen.current);
    };
    const sync = () => {
      setReduced(motion.matches);
      setCompact(compactQuery.matches);
      setPalette(readPalette());
      publish();
    };
    sync();

    const onMotion = () => {
      sync();
    };
    const onCompact = () => {
      sync();
    };
    const onVisibility = () => {
      visible.current = !document.hidden;
      publish();
    };
    motion.addEventListener('change', onMotion);
    compactQuery.addEventListener('change', onCompact);
    document.addEventListener('visibilitychange', onVisibility);

    const node = rootRef.current;
    const observer = node
      ? new IntersectionObserver(
          (entries) => {
            const entry = entries[0];
            onScreen.current = entry?.isIntersecting ?? false;
            publish();
          },
          { threshold: 0.08 },
        )
      : null;
    if (node && observer) observer.observe(node);

    return () => {
      motion.removeEventListener('change', onMotion);
      compactQuery.removeEventListener('change', onCompact);
      document.removeEventListener('visibilitychange', onVisibility);
      observer?.disconnect();
    };
  }, []);

  return (
    <div ref={rootRef} className="hero-beams" aria-hidden="true">
      {!reduced && palette ? (
        <BeamsErrorBoundary>
          <Beams
            beamColor={palette.beam}
            lightColor={palette.light}
            backgroundColor={palette.background}
            beamNumber={compact ? 4 : 8}
            beamWidth={compact ? 3.2 : 2.2}
            beamHeight={16}
            speed={compact ? 0.65 : 1.05}
            noiseIntensity={1.3}
            scale={0.18}
            rotation={18}
            segments={compact ? 32 : 56}
            paused={!active}
            dpr={compact ? [1, 1.15] : [1, 1.5]}
          />
        </BeamsErrorBoundary>
      ) : null}
    </div>
  );
}

'use client';

import dynamic from 'next/dynamic';
import { Component, useEffect, useState, type ReactNode } from 'react';
import type { GradientWavesDetail } from '@/components/gradient-waves';

const GradientWaves = dynamic(() => import('./gradient-waves'), { ssr: false });

interface Palette {
  horizon: string;
  wave: string;
  crest: string;
}

function readPalette(): Palette | null {
  const style = getComputedStyle(document.documentElement);
  const horizon = style.getPropertyValue('--wave-horizon').trim();
  const wave = style.getPropertyValue('--wave-color').trim();
  const crest = style.getPropertyValue('--wave-crest').trim();
  if (!horizon || !wave || !crest) return null;
  return { horizon, wave, crest };
}

class WavesErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  override state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  override render() {
    if (this.state.failed) return null;
    return this.props.children;
  }
}

export function GradientWavesBackground() {
  const [palette, setPalette] = useState<Palette | null>(null);
  const [reduced, setReduced] = useState(true);
  const [compact, setCompact] = useState(false);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const motion = window.matchMedia('(prefers-reduced-motion: reduce)');
    const compactQuery = window.matchMedia('(max-width: 768px)');
    const sync = () => {
      setReduced(motion.matches);
      setCompact(compactQuery.matches);
      setPalette(readPalette());
      setReady(true);
    };
    sync();
    const onChange = () => {
      sync();
    };
    motion.addEventListener('change', onChange);
    compactQuery.addEventListener('change', onChange);
    return () => {
      motion.removeEventListener('change', onChange);
      compactQuery.removeEventListener('change', onChange);
    };
  }, []);

  const detail: GradientWavesDetail = compact ? 'low' : 'medium';

  return (
    <div className="hero-waves" aria-hidden="true">
      {ready && !reduced && palette ? (
        <WavesErrorBoundary>
          <GradientWaves
            horizonColor={palette.horizon}
            waveColor={palette.wave}
            crestColor={palette.crest}
            speed={0.3}
            amplitude={2.15}
            waveScale={0.55}
            waveRatio={0.92}
            swell={28}
            turbulence={12}
            tilt={1.08}
            zoom={1.08}
            height={5.2}
            fogDepth={22}
            detail={detail}
            brightness={0.78}
            opacity={1}
            mouseInteraction={false}
            grain
            grainIntensity={0.035}
            maxDpr={compact ? 1.15 : 1.5}
          />
        </WavesErrorBoundary>
      ) : null}
    </div>
  );
}

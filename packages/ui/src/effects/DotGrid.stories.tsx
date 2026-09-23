import { DotGrid } from './DotGrid';

export default { title: 'Effects/Dot grid' };

export const HeroField = () => (
  <div className="relative flex h-[400px] w-[640px] items-center justify-center overflow-hidden rounded-canvas border border-border-hair bg-canvas">
    <DotGrid radius={260} centerX="50%" centerY="48%" />
    <div className="relative z-10 rounded-2xl border border-border-hair bg-raised px-5 py-4 text-title">
      Ferry
    </div>
  </div>
);

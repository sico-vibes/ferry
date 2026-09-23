import { AmbientGlow } from './AmbientGlow';
import { DotGrid } from './DotGrid';
import { GradientText } from './GradientText';

export default { title: 'Effects/Gradient text' };

export const FerryHero = () => (
  <div className="relative flex min-h-[420px] w-[720px] flex-col items-center justify-center overflow-hidden rounded-canvas border border-border-hair bg-canvas px-10 text-center">
    <AmbientGlow
      glows={[
        { color: 'warm', x: '18%', y: '10%', size: 260 },
        { color: 'blue', x: '78%', y: '14%', size: 300 },
      ]}
    />
    <DotGrid radius={320} centerX="50%" centerY="43%" />
    <div className="relative z-10 mb-7 flex size-14 items-center justify-center rounded-2xl bg-text-1 text-xl font-bold text-app shadow-[0_8px_24px_var(--border-strong)]">
      F
    </div>
    <h1 className="relative z-10 max-w-[560px] text-hero font-semibold leading-[38px] tracking-[-0.01em]">
      <GradientText>Build bigger with Ferry — every free model, one seamless task.</GradientText>
    </h1>
    <p className="relative z-10 mt-3 max-w-[440px] text-body text-text-2">
      Ferry routes each step to the model that still has room, and carries your task across when one
      runs dry.
    </p>
  </div>
);

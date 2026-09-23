import { AmbientGlow } from './AmbientGlow';

export default { title: 'Effects/Ambient glow' };

export const CanvasAtmosphere = () => (
  <div className="relative h-[360px] w-[640px] overflow-hidden rounded-canvas border border-border-hair bg-canvas">
    <AmbientGlow
      glows={[
        { color: 'warm', x: '12%', y: '12%', size: 260 },
        { color: 'blue', x: '72%', y: '18%', size: 300 },
      ]}
    />
    <div className="relative z-10 p-6 text-label text-text-2">Canvas ambient light</div>
  </div>
);

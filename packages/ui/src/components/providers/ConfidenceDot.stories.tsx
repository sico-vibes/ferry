import { ConfidenceDot } from './ConfidenceDot';
export default { title: 'Providers/ConfidenceDot' };
export const Levels = () => (
  <div className="flex gap-3 bg-app p-4">
    {(['exact', 'estimated', 'learned', 'unknown'] as const).map((confidence) => (
      <ConfidenceDot key={confidence} confidence={confidence} />
    ))}
  </div>
);

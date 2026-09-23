import { RingGauge } from './index';
export default { title: 'Data/RingGauge' };
export const Values = () => (
  <div className="flex gap-4 bg-app p-4">
    <RingGauge value={0} />
    <RingGauge value={64} />
    <RingGauge value={100} />
  </div>
);

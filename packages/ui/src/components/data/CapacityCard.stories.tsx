import { CapacityCard } from './index';
export default { title: 'Data/CapacityCard' };
export const Default = () => (
  <div className="w-[272px] bg-app p-3">
    <CapacityCard
      stepsLeft={420}
      percent={64}
      onOpenBreakdown={() => undefined}
      onAddProvider={() => undefined}
    />
  </div>
);

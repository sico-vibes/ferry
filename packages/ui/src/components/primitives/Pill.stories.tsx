import { Share2 } from 'lucide-react';
import { Pill } from './index';
export default { title: 'Primitives/Pill' };
export const Variants = () => (
  <div className="flex flex-wrap gap-3 bg-app p-4">
    <Pill>Outline</Pill>
    <Pill variant="dark">Configuration</Pill>
    <Pill variant="blue-tint">Best Available</Pill>
    <Pill variant="send">Send</Pill>
    <Pill variant="warm-outline" trailingIcon={<Share2 size={14} />}>
      Share
    </Pill>
  </div>
);

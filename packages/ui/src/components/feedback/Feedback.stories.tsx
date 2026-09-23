import { LatticeLoader } from './LatticeLoader';
import { Toaster } from './Toast';
export default { title: 'Feedback/Toast and loader' };
export const Statuses = () => (
  <div className="min-h-[320px] space-y-8 bg-app p-8">
    <LatticeLoader label="Ferry is connecting to the next model" />
    <Toaster
      messages={[
        { id: 'model', kind: 'info', text: 'Switched to NVIDIA Nemotron 3 Ultra' },
        { id: 'checkpoint', kind: 'success', text: 'Checkpoint restored' },
        { id: 'delegate', kind: 'success', text: 'Delegation finished' },
      ]}
    />
    <div className="space-y-2">
      <div className="rounded-xl border border-border-hair bg-panel p-3 text-label text-text-2">
        Switched to NVIDIA Nemotron 3 Ultra
      </div>
      <div className="rounded-xl border border-border-hair bg-panel p-3 text-label text-text-2">
        Checkpoint restored
      </div>
      <div className="rounded-xl border border-border-hair bg-panel p-3 text-label text-text-2">
        Delegation finished
      </div>
    </div>
  </div>
);

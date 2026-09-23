import { GradientBorder } from './GradientBorder';

export default { title: 'Effects/Gradient border' };

export const Composer = () => (
  <GradientBorder
    gradient="composer"
    width={3}
    radius="panel"
    shimmer
    className="w-[640px]"
    innerClassName="bg-input"
    topBand={{
      height: 30,
      content: (
        <div className="flex h-full items-center justify-between px-3 text-label font-medium text-text-1">
          <span>◷ &nbsp; Free capacity low — Gemini resets in 2h 13m</span>
          <a className="text-warn" href="#provider">
            Add provider ↗
          </a>
        </div>
      ),
    }}
  >
    <div className="flex min-h-[148px] flex-col justify-between p-3">
      <div className="text-body text-text-3">Ask Ferry to build, fix or explain…</div>
      <div className="flex items-center justify-between">
        <div className="flex gap-2">
          <button className="rounded-pill border border-border-soft px-3 py-1 text-label text-text-2">
            ↗ Attach
          </button>
          <button className="rounded-pill bg-blue-500/15 px-3 py-1 text-label text-link">
            ◉ Best Available
          </button>
        </div>
        <div className="flex gap-2">
          <button className="rounded-pill border border-border-soft px-3 py-1 text-label text-text-2">
            Voice
          </button>
          <button className="rounded-pill bg-[image:var(--grad-send)] px-3 py-1 text-label font-semibold text-[var(--text-on-send)]">
            Send ↑
          </button>
        </div>
      </div>
    </div>
  </GradientBorder>
);

export const ActiveProfile = () => (
  <GradientBorder gradient="signature" radius="pill" className="w-56" innerClassName="bg-panel">
    <div className="px-3 py-2 text-body font-medium">Best Available</div>
  </GradientBorder>
);

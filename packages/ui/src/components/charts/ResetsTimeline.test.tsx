// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CapacitySummary } from '@ferry/shared';
import { ResetsTimeline } from './ResetsTimeline';
const summary: CapacitySummary = {
  stepsLeftToday: 420,
  percentRemaining: 64,
  lowCapacity: false,
  perProvider: [],
  nextResets: [],
  banner: null,
  updatedAt: new Date().toISOString(),
};
describe('ResetsTimeline', () => {
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it('provides a useful empty state for reset schedules', () => {
    render(<ResetsTimeline summary={summary} providerNames={{}} />);
    expect(screen.getByText('No scheduled resets')).toBeTruthy();
  });

  it('draws and labels each reset within the next 24 hours', () => {
    vi.useFakeTimers();
    const now = new Date('2026-09-23T12:00:00.000Z');
    vi.setSystemTime(now);
    type ProviderId = CapacitySummary['nextResets'][number]['providerId'];
    const resets = [
      { providerId: 'alpha' as ProviderId, windowId: 'alpha-day', label: 'Daily', minutes: 127 },
      { providerId: 'beta' as ProviderId, windowId: 'beta-day', label: 'Daily', minutes: 127 },
      { providerId: 'gamma' as ProviderId, windowId: 'gamma-week', label: 'Weekly', minutes: 720 },
      {
        providerId: 'delta' as ProviderId,
        windowId: 'delta-month',
        label: 'Monthly',
        minutes: 1380,
      },
    ].map(({ minutes, ...reset }) => ({
      ...reset,
      at: new Date(now.getTime() + minutes * 60_000).toISOString(),
    }));
    render(
      <ResetsTimeline
        providerNames={{ alpha: 'Alpha', beta: 'Beta', gamma: 'Gamma', delta: 'Delta' }}
        summary={{ ...summary, nextResets: resets }}
      />,
    );

    const markers = screen.getAllByRole('button');
    expect(markers).toHaveLength(4);
    const markerPositions = markers.map((marker) =>
      Number.parseFloat(marker.getAttribute('style')?.match(/left: ([\d.]+)%/)?.[1] ?? '0'),
    );
    expect(markerPositions).toEqual([...markerPositions].sort((a, b) => a - b));
    expect(markers[0]?.getAttribute('style')).not.toBe(markers[1]?.getAttribute('style'));
    expect(markers[0]?.getAttribute('aria-label')).toContain('Alpha · in 2h 7m ·');
    expect(screen.getAllByText(/in 2h 7m · \d{2}:\d{2}/)).toHaveLength(2);
    expect(screen.getByText(/in 23h 0m · \d{2}:\d{2}/)).toBeTruthy();
  });
});

// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
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
  it('provides a useful empty state for reset schedules', () => {
    render(<ResetsTimeline summary={summary} providerNames={{}} />);
    expect(screen.getByText('No scheduled resets')).toBeTruthy();
  });
});

// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { DataUseBadge, dataUseStatus } from './DataUseBadge';

describe('DataUseBadge', () => {
  it('distinguishes training, no-training, and unknown catalog statements', () => {
    expect(dataUseStatus('Requests may be used to improve products.')).toBe('training');
    expect(dataUseStatus('Does not use customer prompts to train models.')).toBe('no-training');
    expect(dataUseStatus('Subject to provider terms.')).toBe('unknown');
    expect(dataUseStatus(null)).toBe('unknown');
  });

  it('shows the user-facing label and the underlying catalog text', () => {
    render(<DataUseBadge dataUse="Requests may be used to improve products." />);
    expect(screen.getByText('May train on your prompts')).toBeTruthy();
    expect(screen.getByTitle('Requests may be used to improve products.')).toBeTruthy();
  });
});

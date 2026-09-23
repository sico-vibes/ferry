// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { LatticeLoader } from './LatticeLoader';
import { Toaster } from './Toast';
describe('feedback components', () => {
  it('renders a loading status and a dismissible toast stack', () => {
    render(
      <>
        <LatticeLoader label="Connecting" />
        <Toaster messages={[{ id: 'one', kind: 'success', text: 'Checkpoint restored' }]} />
      </>,
    );
    expect(screen.getByRole('status', { name: 'Connecting' })).toBeTruthy();
    expect(screen.getByText('Checkpoint restored')).toBeTruthy();
  });
});

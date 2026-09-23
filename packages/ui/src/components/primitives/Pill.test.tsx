// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Pill } from './index';
describe('Pill', () => {
  it('renders text and size variants as buttons', () => {
    render(
      <>
        <Pill>Outline</Pill>
        <Pill variant="dark" size="lg">
          Configuration
        </Pill>
        <Pill variant="blue-tint">Profile</Pill>
        <Pill variant="send">Send</Pill>
        <Pill variant="warm-outline">Share</Pill>
      </>,
    );
    expect(screen.getByRole('button', { name: 'Outline' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Configuration' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Share' })).toBeTruthy();
  });
});

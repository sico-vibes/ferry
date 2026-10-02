// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Composer } from './index';

describe('composer typography', () => {
  it('keeps composer controls at their v2 sizes', () => {
    render(
      <Composer
        value=""
        onChange={() => undefined}
        onSend={() => undefined}
        onStop={() => undefined}
        running={false}
        profileName="Profile One"
      />,
    );
    const profileButton = screen.getByRole('button', { name: 'Profile One' });
    expect(profileButton.className).toContain('v2-composer-chip');
    expect(profileButton.className).toContain('text-[14px]');
    expect(screen.getByRole('button', { name: 'Send' }).className).toContain('v2-send-button');
  });
});

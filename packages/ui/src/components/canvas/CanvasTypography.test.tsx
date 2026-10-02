// @vitest-environment jsdom
import { Lightbulb } from 'lucide-react';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { IntegrationItem, SidebarItem } from '../nav';
import { Composer } from './index';

describe('canvas and sidebar typography regression', () => {
  it('keeps legacy labels and v2 composer controls at their specified sizes', () => {
    render(
      <>
        <IntegrationItem label="GitHub" slug="github" />
        <Composer
          value=""
          onChange={() => undefined}
          onSend={() => undefined}
          onStop={() => undefined}
          running={false}
          profileName="Profile One"
        />
        <SidebarItem icon={Lightbulb} label="Best Available" />
      </>,
    );

    expect(screen.getByText('GitHub').className).toContain('text-[13px]');
    const profileButton = screen.getByRole('button', { name: 'Profile One' });
    expect(profileButton.className).toContain('v2-composer-chip');
    expect(profileButton.className).toContain('text-[14px]');
    expect(screen.getByRole('button', { name: 'Send' }).className).toContain('v2-send-button');
    expect(
      screen.getByRole('button', { name: 'Best Available' }).parentElement?.className,
    ).toContain('text-[13px]');
  });
});

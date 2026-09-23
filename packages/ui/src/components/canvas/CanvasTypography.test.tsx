// @vitest-environment jsdom
import { Lightbulb } from 'lucide-react';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { IntegrationItem, SidebarItem } from '../nav';
import { Composer } from './index';

describe('canvas and sidebar typography regression', () => {
  it('keeps integration, composer, and sidebar labels at their specified sizes', () => {
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
    expect(screen.getByRole('button', { name: 'Profile One' }).className).toContain('text-[12px]');
    expect(screen.getByRole('button', { name: /Send/ }).className).toContain('text-[12.5px]');
    expect(
      screen.getByRole('button', { name: 'Best Available' }).parentElement?.className,
    ).toContain('text-[13px]');
  });
});

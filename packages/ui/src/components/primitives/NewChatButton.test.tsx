// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { NewChatButton } from './index';
describe('NewChatButton', () => {
  it('renders large and compact controls', () => {
    render(
      <>
        <NewChatButton />
        <NewChatButton size="sm" />
      </>,
    );
    expect(screen.getAllByRole('button', { name: /New Chat/ })).toHaveLength(2);
  });
});

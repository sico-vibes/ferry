// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { SidebarPanel } from './index';
describe('SidebarPanel', () => {
  it('renders header, body and footer slots', () => {
    render(
      <SidebarPanel header={<span>Chats</span>} footer={<span>Settings</span>}>
        Content
      </SidebarPanel>,
    );
    expect(screen.getByText('Chats')).toBeTruthy();
    expect(screen.getByText('Content')).toBeTruthy();
    expect(screen.getByText('Settings')).toBeTruthy();
  });
});

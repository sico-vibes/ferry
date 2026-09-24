// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import {
  CanvasHeaderActions,
  CanvasPanel,
  Composer,
  ContinueRow,
  Disclaimer,
  Hero,
  ModelPickerTrigger,
  PinnedChatsRow,
  SuggestionChips,
} from './index';
describe('canvas building blocks', () => {
  it('models the picker and scrollable chat cards', () => {
    const click = vi.fn();
    render(
      <>
        <ModelPickerTrigger mode="auto" modelName="GLM-5.3" onClick={click} />
        <PinnedChatsRow
          cards={[{ language: 'ts', title: 'Auth', snippet: 'Tokens', date: 'Today' }]}
        />
      </>,
    );
    fireEvent.click(screen.getByRole('button', { name: /Auto · GLM/ }));
    expect(click).toHaveBeenCalledOnce();
    expect(screen.getByRole('button', { name: /Auth/ })).toBeTruthy();
  });
  it('moves the Continue card row with keyboard arrows', () => {
    render(
      <ContinueRow cards={[{ language: 'ts', title: 'Auth', snippet: 'Tokens', date: 'Today' }]} />,
    );
    const row = screen.getByRole('region', { name: 'Continue sessions' });
    const scrollBy = vi.fn();
    Object.defineProperty(row, 'scrollBy', { configurable: true, value: scrollBy });
    fireEvent.keyDown(row, { key: 'ArrowRight' });
    expect(scrollBy).toHaveBeenCalledWith({ left: 208, behavior: 'smooth' });
  });
  it('sends on Enter, preserves Shift+Enter, and stops an active run', () => {
    const send = vi.fn(),
      stop = vi.fn(),
      change = vi.fn();
    const { rerender } = render(
      <Composer
        value="fix tests"
        onChange={change}
        onSend={send}
        onStop={stop}
        running={false}
        profileName="Best Available"
      />,
    );
    const input = screen.getByRole('textbox');
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(send).toHaveBeenCalledOnce();
    fireEvent.keyDown(input, { key: 'Enter', shiftKey: true });
    expect(send).toHaveBeenCalledOnce();
    rerender(
      <Composer
        value="fix tests"
        onChange={change}
        onSend={send}
        onStop={stop}
        running
        profileName="Best Available"
      />,
    );
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(stop).toHaveBeenCalledOnce();
  });
  it('renders the canvas shell, hero, actions, suggestions, and disclaimer', () => {
    const selected = vi.fn();
    const shared = vi.fn();
    render(
      <CanvasPanel
        dots
        header={
          <>
            <ModelPickerTrigger mode="manual" modelName="GLM-5.3" />
            <CanvasHeaderActions onShare={shared} />
          </>
        }
      >
        <Hero title={['Build bigger', 'with Ferry']} subtitle="Carry a task across models." />
        <SuggestionChips onSelect={selected} />
        <Disclaimer />
      </CanvasPanel>,
    );
    expect(screen.getByRole('heading', { name: /Build bigger/ })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Explain this repo/ }));
    fireEvent.click(screen.getByRole('button', { name: /Share/ }));
    expect(selected).toHaveBeenCalledWith('Explain this repo');
    expect(shared).toHaveBeenCalledOnce();
    expect(screen.getByRole('link', { name: 'Data use' })).toBeTruthy();
  });
});

// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { AmbientGlow } from '../src/effects/AmbientGlow';
import { DotGrid } from '../src/effects/DotGrid';
import { FadeSeparator } from '../src/effects/FadeSeparator';
import { GlowLine } from '../src/effects/GlowLine';
import { GradientBorder } from '../src/effects/GradientBorder';
import { GradientText } from '../src/effects/GradientText';

afterEach(cleanup);

function getStyles(element: Element | null): string {
  return element?.getAttribute('style') ?? '';
}

describe('effect primitives', () => {
  it('renders the vertical glow line with edge sizing and token colors', () => {
    const { container } = render(<GlowLine orientation="vertical" from="30%" to="92%" />);
    const line = container.firstElementChild;
    const styles = getStyles(line);
    expect(styles).toContain('width: 1px');
    expect(styles).toContain('top: 30%');
    expect(styles).toContain('bottom:');
    expect(styles).toContain('box-shadow: 0 0 12px 1px var(--blue-glow)');
    expect(styles).toContain('var(--blue-500)');
  });

  it('sizes a horizontal glow line on the horizontal axis', () => {
    const { container } = render(<GlowLine orientation="horizontal" from="15%" to="85%" />);
    const styles = getStyles(container.firstElementChild);
    expect(styles).toContain('height: 1px');
    expect(styles).toContain('left: 15%');
    expect(styles).toContain('right:');
  });

  it('renders a neutral fade separator with the design spacing', () => {
    const { container } = render(<FadeSeparator />);
    const styles = getStyles(container.firstElementChild);
    expect(styles).toContain('height: 1px');
    expect(styles).toContain('margin-block: 16px');
    expect(styles).toContain('background: var(--fade-line)');
  });

  it('renders the blue separator tone with a halo', () => {
    const { container } = render(<FadeSeparator tone="blue" />);
    const styles = getStyles(container.firstElementChild);
    expect(styles).toContain('var(--blue-500)');
    expect(styles).toContain('box-shadow: 0 0 12px 1px var(--blue-glow)');
  });

  it('uses the selected gradient token and reduced-motion class', () => {
    const { container } = render(
      <GradientBorder gradient="composer" radius="panel">
        Input
      </GradientBorder>,
    );
    expect(getStyles(container.firstElementChild)).toContain('background: var(--grad-composer)');
    expect(container.firstElementChild?.className).toContain('motion-reduce:animate-none');
  });

  it('renders the top band before the inset content', () => {
    render(
      <GradientBorder
        gradient="composer"
        radius="panel"
        topBand={{ height: 30, content: <div>Capacity notice</div> }}
      >
        <div>Composer input</div>
      </GradientBorder>,
    );
    expect(
      screen
        .getByText('Capacity notice')
        .compareDocumentPosition(screen.getByText('Composer input')),
    ).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
  });

  it('builds ambient glow layers from effect tokens', () => {
    const { container } = render(
      <AmbientGlow glows={[{ color: 'warm', x: '12%', y: '10%', size: 260 }]} />,
    );
    expect(getStyles(container.firstElementChild)).toContain('var(--glow-warm)');
  });

  it('renders a dotted field and applies the radial mask', () => {
    const { container } = render(<DotGrid radius={420} centerX="50%" centerY="45%" />);
    const styles = getStyles(container.firstElementChild);
    expect(styles).toContain('var(--dot-color)');
    expect(styles).toContain('background-size: 14px 14px');
    expect(styles).toContain('420px at 50% 45%');
  });

  it('uses headline or signature gradient tokens for text', () => {
    const { container } = render(<GradientText>Build bigger</GradientText>);
    expect(getStyles(container.firstElementChild)).toContain(
      'background-image: var(--grad-headline)',
    );
    expect(container.firstElementChild?.className).toContain('bg-clip-text');
    expect(container.firstElementChild?.className).toContain('text-transparent');
  });
});

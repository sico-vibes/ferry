// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { AnimatedList } from './AnimatedList';
import { CountUp } from './CountUp';
describe('motion data accents', () => {
  it('renders animated list rows and a number counter', () => {
    const { container } = render(
      <>
        <AnimatedList>
          {[<span key="one">Auth refactor</span>, <span key="two">Fix flaky tests</span>]}
        </AnimatedList>
        <CountUp to={420} />
      </>,
    );
    expect(screen.getByText('Auth refactor')).toBeTruthy();
    expect(screen.getByText('Fix flaky tests')).toBeTruthy();
    expect(container.querySelector('span')).toBeTruthy();
  });
});

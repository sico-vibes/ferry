import { describe, expect, it } from 'vitest';
import { crossing, faq, features, hero, links, steps } from '../src/lib/site';

describe('landing story', () => {
  it('sends the download CTA to GitHub releases', () => {
    expect(links.download).toBe('https://github.com/sico-vibes/ferry/releases');
    expect(links.github).toBe('https://github.com/sico-vibes/ferry');
  });

  it('keeps the ferry story and the six product points', () => {
    expect(hero.title.toLowerCase()).toContain('ferry');
    expect(hero.support).toBe('All free providers. One gateway. Smart routing.');
    expect(features.map((item) => item.title)).toEqual([
      'Free providers hub',
      'Smart routing',
      'Key health and rotation',
      'Desktop + CLI',
      'Local-first',
      'Honest BYOK',
    ]);
    expect(steps.map((step) => step.title)).toEqual(['Add keys', 'Pick a route', 'Code']);
    expect(crossing.lead.toLowerCase()).toContain('gateway');
    expect(crossing.body.toLowerCase()).toContain('openai-compatible');
    expect(crossing.body.toLowerCase()).not.toContain('desktop session');
  });

  it('does not promise pooled accounts or a fixed free quota', () => {
    const text = [hero.body, hero.honest, ...faq.flatMap((item) => [item.question, item.answer])]
      .join(' ')
      .toLowerCase();
    expect(text).toContain('bring your own');
    expect(text).toContain('does not pool');
    expect(text).toContain('providers');
    expect(text).not.toContain('unlimited');
  });
});

// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { parseChangelog, shouldShowWhatsNew } from './WhatsNewDialog';

describe('parseChangelog', () => {
  it('reads releases, groups and wrapped bullets, newest first', () => {
    const releases = parseChangelog(
      [
        '# Changelog',
        '',
        '## [Unreleased]',
        '',
        '### Added',
        '',
        '- Waits for short limits instead of switching',
        '  to a weaker model.',
        '- `check_page` tool.',
        '',
        '## [0.9.0-beta.71] - 2026-10-08',
        '',
        '### Fixed',
        '',
        '- Groq second step.',
        '',
        '## [0.9.0-beta.1] - 2026-09-01',
        '',
      ].join('\n'),
    );
    expect(releases.map((release) => release.version)).toEqual(['Unreleased', '0.9.0-beta.71']);
    expect(releases[0]?.groups[0]).toEqual({
      title: 'Added',
      items: [
        'Waits for short limits instead of switching to a weaker model.',
        '`check_page` tool.',
      ],
    });
    expect(releases[1]?.date).toBe('2026-10-08');
  });
});

describe('shouldShowWhatsNew', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('stays quiet on a first install and opens once after an update', () => {
    expect(shouldShowWhatsNew('0.9.0-beta.71')).toBe(false);
    expect(shouldShowWhatsNew('0.9.0-beta.71')).toBe(false);
    expect(shouldShowWhatsNew('0.9.0-beta.72')).toBe(true);
    expect(shouldShowWhatsNew('0.9.0-beta.72')).toBe(false);
    expect(shouldShowWhatsNew(undefined)).toBe(false);
  });
});

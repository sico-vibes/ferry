import { describe, expect, it } from 'vitest';
import { isCloudConfigured, loadCloudConfig, parseDotEnv } from '../src/index.js';

describe('cloud config', () => {
  it('parses only cloud settings and respects process environment precedence', () => {
    expect(
      parseDotEnv(
        'OTHER=ignored\nFERRY_SUPABASE_URL="https://example.test" # note\nexport FERRY_CLOUD_OWNER_EMAIL=a@example.test',
      ),
    ).toEqual({
      FERRY_SUPABASE_URL: 'https://example.test',
      FERRY_CLOUD_OWNER_EMAIL: 'a@example.test',
    });
    const config = loadCloudConfig({
      cwd: '/repo',
      env: { FERRY_SUPABASE_URL: 'https://env.test' },
      readFile: (path) =>
        path === '/repo/config/.env'
          ? 'FERRY_SUPABASE_URL=https://file.test\nFERRY_SUPABASE_PUBLISHABLE_KEY=public-value'
          : undefined,
    });
    expect(config).toEqual({
      url: 'https://env.test',
      publishableKey: 'public-value',
      schema: 'ferry',
      ownerEmail: undefined,
    });
    expect(isCloudConfigured(config)).toBe(true);
  });
});

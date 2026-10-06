import { describe, expect, it } from 'vitest';
import { isCloudConfigured, loadCloudConfig, parseDotEnv } from '../src/index.js';

const slashes = (path: string) => path.replaceAll('\\', '/');

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
      ferryHome: '/home/ferry',
      env: { FERRY_SUPABASE_URL: 'https://env.test' },
      readFile: (path) =>
        slashes(path).endsWith('/home/ferry/cloud.env')
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

  it('never reads config from the working directory or its parents', () => {
    const read: string[] = [];
    loadCloudConfig({
      ferryHome: '/home/ferry',
      env: {},
      readFile: (path) => {
        read.push(slashes(path));
        return undefined;
      },
    });
    expect(read).toHaveLength(2);
    expect(read[0]).toMatch(/\/home\/ferry\/config\/\.env$/);
    expect(read[1]).toMatch(/\/home\/ferry\/cloud\.env$/);
  });

  it('reads an explicit FERRY_CLOUD_ENV_FILE over the Ferry home files', () => {
    const config = loadCloudConfig({
      ferryHome: '/home/ferry',
      env: { FERRY_CLOUD_ENV_FILE: '/secrets/ferry.env' },
      readFile: (path) => {
        if (slashes(path).endsWith('/home/ferry/cloud.env'))
          return 'FERRY_SUPABASE_URL=https://home.test';
        if (slashes(path).endsWith('/secrets/ferry.env'))
          return 'FERRY_SUPABASE_URL=https://explicit.test\nFERRY_SUPABASE_PUBLISHABLE_KEY=k';
        return undefined;
      },
    });
    expect(config.url).toBe('https://explicit.test');
  });
});

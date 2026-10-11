import { expect, it } from 'vitest';
import { cliAuthStatus } from '../src/index.js';
it('distinguishes successful command execution from a confirmed sign-in', () => {
  expect(cliAuthStatus('0 credentials', '', false)).toBe('signed_out');
  expect(cliAuthStatus('Credentials', '', false)).toBe('unknown');
  expect(cliAuthStatus('3 credentials', '', false)).toBe('signed_in');
  expect(cliAuthStatus('{"loggedIn":true}', '', false)).toBe('signed_in');
  expect(cliAuthStatus('', 'Logged in using an API key', false)).toBe('signed_in');
  expect(cliAuthStatus('Not logged in', '', false)).toBe('signed_out');
});

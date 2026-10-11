// @vitest-environment node
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';
import { powershellUtf8Arguments } from '../../scripts/powershell-utf8.mjs';

const execute = promisify(execFile);

it.skipIf(process.platform !== 'win32')(
  'preserves Unicode paths when PowerShell starts with a legacy output code page',
  { timeout: 60_000 },
  async () => {
    const expected = "C:\\Ferry user's 日本語 install\\resources\\cli";
    const script = `Write-Output '${expected.replaceAll("'", "''")}'; exit 0`;
    const args = powershellUtf8Arguments(script);
    // Model the runner's legacy console encoding before the harness configures its output.
    args[args.length - 1] =
      `[Console]::OutputEncoding = [Text.Encoding]::GetEncoding(437); ${args.at(-1) ?? ''}`;
    const result = await execute('powershell.exe', args, {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 45_000,
    });
    expect(result.stdout.trim()).toBe(expected);
  },
);

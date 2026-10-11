import { spawnSync } from 'node:child_process';
import { expect, it } from 'vitest';
import { powershellUtf8Arguments } from '../../scripts/powershell-utf8.mjs';

it.skipIf(process.platform !== 'win32')(
  'preserves Unicode paths when PowerShell starts with a legacy output code page',
  { timeout: 30_000 },
  () => {
    const expected = "C:\\Ferry user's 日本語 install\\resources\\cli";
    const script = `Write-Output '${expected.replaceAll("'", "''")}'; exit 0`;
    const args = powershellUtf8Arguments(script);
    // Model the runner's legacy console encoding before the harness configures its output.
    args[args.length - 1] =
      `[Console]::OutputEncoding = [Text.Encoding]::GetEncoding(437); ${args.at(-1) ?? ''}`;
    const result = spawnSync('powershell.exe', args, {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 20_000,
    });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe(expected);
  },
);

// @vitest-environment node
import { execFile } from 'node:child_process';
import { expect, it } from 'vitest';
import { powershellUtf8Arguments } from '../../scripts/powershell-utf8.mjs';

const DIAGNOSTIC_LIMIT = 400;

function clipDiagnostic(text: string): string {
  const value = text.trim();
  return value.length > DIAGNOSTIC_LIMIT
    ? `${value.slice(0, DIAGNOSTIC_LIMIT)}…[${String(value.length)} chars]`
    : value;
}

function executePowershell(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      'powershell.exe',
      args,
      { encoding: 'utf8', windowsHide: true, timeout: 45_000 },
      (error, stdout, stderr) => {
        if (error) {
          reject(
            new Error(
              [
                `powershell.exe failed (code=${String(error.code)}, signal=${String(error.signal)}, killed=${String(error.killed)})`,
                `stdout="${clipDiagnostic(stdout)}"`,
                `stderr="${clipDiagnostic(stderr)}"`,
              ].join('; '),
            ),
          );
          return;
        }
        resolve(stdout);
      },
    );
    // This command needs no piped input. An async execFile leaves the child's
    // stdin pipe open; close it explicitly so a child consuming pipeline input
    // can observe EOF. The command does not receive any input.
    child.stdin?.end();
  });
}

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
    expect((await executePowershell(args)).trim()).toBe(expected);
  },
);

it.skipIf(process.platform !== 'win32')(
  'closes unused stdin when PowerShell consumes pipeline input',
  { timeout: 60_000 },
  async () => {
    const args = powershellUtf8Arguments("$input | Out-Null; Write-Output 'stdin closed'; exit 0");
    expect((await executePowershell(args)).trim()).toBe('stdin closed');
  },
);

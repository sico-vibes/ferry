// @vitest-environment node
import { spawnSync } from 'node:child_process';
import { expect, it } from 'vitest';
import { powershellUtf8Arguments } from '../../scripts/powershell-utf8.mjs';

const CHILD_TIMEOUT_MS = 45_000;
const DIAGNOSTIC_LIMIT = 400;

function clipDiagnostic(text: string | null | undefined): string {
  const value = (text ?? '').trim();
  return value.length > DIAGNOSTIC_LIMIT
    ? `${value.slice(0, DIAGNOSTIC_LIMIT)}…[${String(value.length)} chars]`
    : value;
}

/** Emits a stderr stage marker so a stall can be attributed to a specific launch phase. */
function stage(name: string): string {
  return `[Console]::Error.WriteLine('ps-stage:${name}')`;
}

// Runs PowerShell through the same synchronous harness the installer uses for its
// registry queries. spawnSync hands the child a closed stdin (EOF) and does not
// depend on async pipe reads, unlike the previous execFile wrapper.
function executePowershell(args: string[]): string {
  const result = spawnSync('powershell.exe', args, {
    encoding: 'utf8',
    windowsHide: true,
    timeout: CHILD_TIMEOUT_MS,
  });
  if (result.error || result.signal || result.status !== 0) {
    throw new Error(
      [
        `powershell.exe failed (status=${String(result.status)}, signal=${String(result.signal)}, error=${String(result.error?.message)})`,
        `stages="${clipDiagnostic(result.stderr)}"`,
        `stdout="${clipDiagnostic(result.stdout)}"`,
      ].join('; '),
    );
  }
  return result.stdout;
}

it.skipIf(process.platform !== 'win32')(
  'preserves Unicode paths when PowerShell starts with a legacy output code page',
  { timeout: 60_000 },
  () => {
    const expected = "C:\\Ferry user's 日本語 install\\resources\\cli";
    const script = `${stage('utf8')}; Write-Output '${expected.replaceAll("'", "''")}'; ${stage('emit')}; exit 0`;
    const args = powershellUtf8Arguments(script);
    // Model the runner's legacy console encoding before the harness configures its output.
    args[args.length - 1] =
      `${stage('start')}; [Console]::OutputEncoding = [Text.Encoding]::GetEncoding(437); ${stage('legacy')}; ${args.at(-1) ?? ''}`;
    expect(executePowershell(args).trim()).toBe(expected);
  },
);

it.skipIf(process.platform !== 'win32')(
  'closes unused stdin when PowerShell consumes pipeline input',
  { timeout: 60_000 },
  () => {
    const args = powershellUtf8Arguments(
      `${stage('start')}; $input | Out-Null; Write-Output 'stdin closed'; exit 0`,
    );
    expect(executePowershell(args).trim()).toBe('stdin closed');
  },
);

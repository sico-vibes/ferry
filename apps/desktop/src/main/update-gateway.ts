import { execFile } from 'node:child_process';
import { readFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';

export function gatewayBelongsToInstall(
  process: { executable: string; commandLine: string },
  installDirectory: string,
): boolean {
  const normalize = (value: string) => resolve(value).toLowerCase();
  return (
    normalize(process.executable) === normalize(join(installDirectory, 'Ferry.exe')) &&
    /(?:^|\s)--gateway(?:\s|$)/.test(process.commandLine) &&
    /(?:^|\s)serve(?:\s|$)/.test(process.commandLine) &&
    process.commandLine
      .toLowerCase()
      .includes(join(installDirectory, 'resources', 'cli', 'ferry.js').toLowerCase())
  );
}

export async function stopInstalledGateway(
  dataDirectory: string,
  installDirectory: string,
): Promise<void> {
  if (process.platform !== 'win32') return;
  const statusPath = join(dataDirectory, 'gateway-status.json');
  const status: unknown = await readFile(statusPath, 'utf8').then(
    (value) => JSON.parse(value) as unknown,
    () => null,
  );
  if (
    typeof status !== 'object' ||
    status === null ||
    !('pid' in status) ||
    typeof status.pid !== 'number' ||
    !Number.isSafeInteger(status.pid) ||
    status.pid <= 1 ||
    status.pid === process.pid
  )
    return;
  const pid = status.pid;
  const owner = await new Promise<{ executable: string; commandLine: string } | null>(
    (resolveResult, reject) => {
      execFile(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          `$p=Get-CimInstance Win32_Process -Filter "ProcessId=${String(pid)}"; if ($p) { @{ executable=$p.ExecutablePath; commandLine=$p.CommandLine } | ConvertTo-Json -Compress }`,
        ],
        { windowsHide: true, timeout: 5_000 },
        (error, output) => {
          if (error) {
            reject(
              error instanceof Error
                ? error
                : new Error('Could not parse Gateway process ownership'),
            );
            return;
          }
          try {
            resolveResult(
              output.trim()
                ? (JSON.parse(output) as { executable: string; commandLine: string })
                : null,
            );
          } catch (error) {
            reject(
              error instanceof Error
                ? error
                : new Error('Could not parse Gateway process ownership'),
            );
          }
        },
      );
    },
  );
  if (!owner || !gatewayBelongsToInstall(owner, installDirectory)) return;
  try {
    process.kill(pid, 'SIGTERM');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
  }
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
      await rm(statusPath, { force: true });
      return;
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
  }
  throw new Error('The installed Gateway did not stop before the update.');
}

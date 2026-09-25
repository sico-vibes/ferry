import { accessSync, constants, existsSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
type DoctorCli = 'codex' | 'opencode' | 'claude';
interface CliProbeResult {
  available: boolean;
  version: string | null;
  error?: string;
}

const execFileAsync = promisify(execFile);
export interface DoctorRow {
  name: string;
  status: 'ok' | 'warn' | 'fail';
  reason: string;
}
export interface DoctorProbes {
  resolveCommand(name: string): string | null;
  version(path: string, args: string[], timeoutMs: number): Promise<string>;
  detectCli(name: DoctorCli, path: string, timeoutMs: number): Promise<string>;
  detectAcpAgents(): Promise<AcpDoctorAgent[]>;
  loadModule(specifier: string): Promise<unknown>;
  openSqlite(): Promise<void>;
  dataDirectory: string;
  nodeVersion: string;
  platform: string;
}
interface AcpDoctorAgent {
  name: string;
  available: boolean;
  version: string | null;
  executable: string | null;
  installHint: string;
  error?: string;
}

export function resolveCommand(name: string, env = process.env): string | null {
  const extensions =
    process.platform === 'win32' ? (env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';') : [''];
  for (const dir of (env.PATH ?? '').split(delimiter)) {
    if (!dir) continue;
    for (const extension of extensions) {
      const candidate = join(
        dir,
        name.toLowerCase().endsWith(extension.toLowerCase()) ? name : `${name}${extension}`,
      );
      if (!existsSync(candidate)) continue;
      try {
        accessSync(candidate, process.platform === 'win32' ? constants.F_OK : constants.X_OK);
        return candidate;
      } catch {
        /* Continue through PATH entries. */
      }
    }
  }
  return null;
}

const defaultProbes: DoctorProbes = {
  resolveCommand,
  async version(path, args, timeoutMs) {
    const { stdout } = await execFileAsync(path, args, {
      encoding: 'utf8' as const,
      timeout: timeoutMs,
      windowsHide: true,
    });
    return stdout.trim().split(/\r?\n/)[0] ?? 'version command returned no output';
  },
  async detectCli(name, path, timeoutMs) {
    const delegateModule = (await import('@ferry/delegate')) as unknown as {
      detectCli(
        cli: DoctorCli,
        options: { executable: string; timeoutMs: number; checkAuth: false },
      ): Promise<CliProbeResult>;
    };
    const result = await delegateModule.detectCli(name, {
      executable: path,
      timeoutMs,
      checkAuth: false,
    });
    if (!result.available || !result.version)
      throw new Error(result.error ?? 'Version probe failed');
    return result.version.split(/\r?\n/)[0] ?? result.version;
  },
  async detectAcpAgents() {
    const delegateModule = (await import('@ferry/delegate')) as unknown as {
      detectAcpAgents(): Promise<AcpDoctorAgent[]>;
    };
    return await delegateModule.detectAcpAgents();
  },
  loadModule: (specifier) => import(specifier),
  async openSqlite() {
    const driver = 'better-sqlite3';
    const loaded = (await import(driver)) as { default: unknown };
    const Constructor = loaded.default as new (path: string) => { close(): void };
    const db = new Constructor(':memory:');
    db.close();
  },
  dataDirectory: join(process.env.APPDATA ?? process.env.HOME ?? process.cwd(), '.ferry'),
  nodeVersion: process.version,
  platform: process.platform,
};

export async function collectDoctor(overrides: Partial<DoctorProbes> = {}): Promise<DoctorRow[]> {
  const probes: DoctorProbes = { ...defaultProbes, ...overrides };
  const names = ['codex', 'opencode', 'claude'];
  const cliChecks = await Promise.all(
    names.map(async (name): Promise<DoctorRow> => {
      const path = probes.resolveCommand(name);
      if (!path)
        return {
          name,
          status: 'warn',
          reason: 'not found on PATH (PATHEXT checked where supported)',
        };
      try {
        const version = await probes.detectCli(name as DoctorCli, path, 5_000);
        return { name, status: 'ok', reason: `${version} · ${path}` };
      } catch (error) {
        return {
          name,
          status: 'fail',
          reason: `found at ${path}, but --version failed: ${message(error)}`,
        };
      }
    }),
  );
  const [keyring, sqlite, pty, rg, acpAgents] = await Promise.all([
    moduleCheck('keyring', '@napi-rs/keyring', probes),
    sqliteCheck(probes),
    moduleCheck('pty', 'node-pty', probes),
    rgCheck(probes),
    probes.detectAcpAgents(),
  ]);
  return [
    { name: 'Node', status: 'ok', reason: probes.nodeVersion },
    { name: 'Data dir', status: 'ok', reason: probes.dataDirectory },
    keyring,
    sqlite,
    rg,
    pty,
    ...cliChecks,
    ...acpAgents.map((agent): DoctorRow => ({
      name: `ACP: ${agent.name}`,
      status: agent.available ? 'ok' : 'warn',
      reason: agent.available
        ? `${agent.version ?? 'Detected'} · ${agent.executable ?? 'PATH'}`
        : `${agent.installHint}${agent.error ? ` (${agent.error})` : ''}`,
    })),
  ];
}

async function moduleCheck(
  label: string,
  specifier: string,
  probes: DoctorProbes,
): Promise<DoctorRow> {
  try {
    await probes.loadModule(specifier);
    return { name: label, status: 'ok', reason: `${specifier} loaded` };
  } catch (error) {
    return { name: label, status: 'warn', reason: `${specifier} unavailable: ${message(error)}` };
  }
}
async function sqliteCheck(probes: DoctorProbes): Promise<DoctorRow> {
  try {
    await probes.openSqlite();
    return { name: 'SQLite', status: 'ok', reason: 'better-sqlite3 opened and closed :memory:' };
  } catch (error) {
    return {
      name: 'SQLite',
      status: 'warn',
      reason: `better-sqlite3 probe failed: ${message(error)}`,
    };
  }
}
async function rgCheck(probes: DoctorProbes): Promise<DoctorRow> {
  try {
    const mod = (await probes.loadModule('@vscode/ripgrep')) as { rgPath?: unknown };
    if (typeof mod.rgPath !== 'string')
      return { name: 'ripgrep', status: 'warn', reason: '@vscode/ripgrep did not provide rgPath' };
    const version = await probes.version(mod.rgPath, ['--version'], 5_000);
    return { name: 'ripgrep', status: 'ok', reason: `${version} · ${mod.rgPath}` };
  } catch (error) {
    return {
      name: 'ripgrep',
      status: 'warn',
      reason: `@vscode/ripgrep unavailable: ${message(error)}`,
    };
  }
}
function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

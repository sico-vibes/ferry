import { access, readFile } from 'node:fs/promises';
import { delimiter, dirname, join, resolve } from 'node:path';
import type { ToolLaunch } from './tool-config.js';

/** Resolve Windows npm Node shims without a shell, preserving literal tool arguments. */
export async function toolProcess(
  launch: ToolLaunch,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): Promise<{ command: string; args: string[] }> {
  if (platform !== 'win32') return { command: launch.command, args: launch.args };
  const path = Object.entries(env).find(([name]) => name.toLowerCase() === 'path')?.[1] ?? '';
  for (const directory of path.split(delimiter).filter(Boolean)) {
    for (const extension of ['.exe', '.cmd']) {
      const executable = join(directory.replace(/^"|"$/g, ''), launch.command + extension);
      try {
        await access(executable);
      } catch {
        continue;
      }
      if (extension === '.exe') return { command: executable, args: launch.args };
      const shim = await readFile(executable, 'utf8');
      const script = [...shim.matchAll(/"%(?:dp0%|~dp0)[\\/]([^"\r\n]+)"/gi)]
        .map((match) => match[1])
        .find((value) => value !== undefined && !/\.exe$/i.test(value));
      if (!script)
        throw new Error(
          `Unsupported ${launch.command} launcher: ${executable}. Install the native executable or the tool's Node CLI.`,
        );
      const entry = resolve(dirname(executable), script);
      await access(entry);
      return { command: process.execPath, args: [entry, ...launch.args] };
    }
  }
  throw new Error(
    `${launch.command} was not found on PATH. Install it before ferry run ${launch.command}.`,
  );
}

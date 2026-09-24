const SUPPORTED =
  /^(git\s+(status|diff|log)|(?:pnpm|npm|yarn)\s+(test|install)|npx\s+(vitest|jest|mocha)|(?:vitest|jest|mocha|pytest|go\s+test|cargo\s+(test|build))|(?:tsc|eslint|ruff)|(?:ls|dir|tree|get-childitem))(\s|$)/i;
export function rtkAvailable(
  pathValue: string | undefined,
  exists: (candidate: string) => boolean,
): boolean {
  if (!pathValue) return false;
  const windowsPath = pathValue.includes(';');
  return pathValue.split(windowsPath ? ';' : ':').some((directory) => {
    const clean = directory.replace(/[\\/]$/, '');
    return windowsPath
      ? exists(`${clean}\\rtk.exe`) || exists(`${clean}\\rtk`)
      : exists(`${clean}/rtk`);
  });
}
export function rewriteWithRtk(command: string, enabled: boolean): string {
  const prefix = /^\s*&\s*/.exec(command)?.[0] ?? '';
  const trimmed = command
    .trim()
    .replace(/^&\s*/, '')
    .replace(/\.(?:cmd|exe)(?=\s|$)/i, '');
  if (!enabled || /^rtk\s/i.test(trimmed)) return command;
  return SUPPORTED.test(trimmed) ? `${prefix}rtk ${trimmed}` : command;
}

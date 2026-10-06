import os from 'node:os';
import path from 'node:path';

/** True for locations where a recursive workspace scan can cover the user's whole machine. */
export function isRiskyWorkspaceRoot(
  workspacePath: string,
  homePath = os.homedir(),
  windowsPath = process.env.WINDIR ?? 'C:\\Windows',
): boolean {
  const windowsStyle = /^[a-z]:[\\/]/i.test(workspacePath);
  const paths = windowsStyle ? path.win32 : path;
  const candidate = paths.resolve(workspacePath);
  const root = paths.parse(candidate).root;
  const home = paths.resolve(homePath);
  const system = paths.resolve(windowsPath);
  const equal = (left: string, right: string) =>
    left.toLocaleLowerCase() === right.toLocaleLowerCase();
  const within = (parent: string, child: string) => {
    const relative = paths.relative(parent, child);
    return relative === '' || (!relative.startsWith('..') && !paths.isAbsolute(relative));
  };
  return (
    equal(candidate, root) || equal(candidate, home) || (windowsStyle && within(system, candidate))
  );
}

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execa } from 'execa';
import simpleGit from 'simple-git';
import { glob } from 'tinyglobby';
import { z } from 'zod';
import { WorkspaceJail } from './fs.js';

export const GitPathInput = z.object({ path: z.string().default('.') });
export const CheckpointInput = z.object({
  dataDir: z.string(),
  message: z.string().default('checkpoint'),
});
export const RestoreCheckpointInput = z.object({
  dataDir: z.string(),
  id: z.string(),
  path: z.string().optional(),
});
export async function gitStatus(jail: WorkspaceJail) {
  return simpleGit(jail.root).status();
}
export async function gitDiff(jail: WorkspaceJail, file?: string) {
  if (file) await jail.resolve(file);
  return simpleGit(jail.root).diff(file ? ['--', file] : []);
}
export async function gitLog(jail: WorkspaceJail, maxCount = 20) {
  return simpleGit(jail.root).log({ maxCount: Math.max(1, Math.min(100, maxCount)) });
}
export async function gitBranch(jail: WorkspaceJail) {
  return simpleGit(jail.root).branch();
}
export class ShadowCheckpoints {
  readonly id: string;
  readonly dir: string;
  constructor(
    readonly jail: WorkspaceJail,
    dataDir: string,
  ) {
    this.id = createHash('sha256').update(jail.root.toLowerCase()).digest('hex').slice(0, 16);
    this.dir = path.join(dataDir, 'checkpoints', this.id);
  }
  async snapshot(message = 'checkpoint'): Promise<string> {
    await fs.mkdir(path.dirname(this.dir), { recursive: true });
    try {
      await fs.access(path.join(this.dir, 'HEAD'));
    } catch {
      await execa('git', ['init', '--bare', this.dir], { cwd: this.jail.root });
    }
    await this.git(['add', '-A']);
    const tree = await this.git(['write-tree']);
    const parent = await this.git(['rev-parse', '-q', '--verify', 'HEAD']).catch(() => undefined);
    if (parent?.stdout.trim()) {
      const oldTree = (await this.git(['rev-parse', 'HEAD^{tree}'])).stdout.trim();
      if (oldTree === tree.stdout.trim()) return parent.stdout.trim();
    }
    const args = ['commit-tree', tree.stdout.trim(), '-m', message];
    if (parent?.stdout.trim()) args.push('-p', parent.stdout.trim());
    const commit = (await this.git(args)).stdout.trim();
    await this.git(['update-ref', 'refs/heads/main', commit]);
    await this.git(['symbolic-ref', 'HEAD', 'refs/heads/main']);
    return commit;
  }
  async list() {
    const result = await this.git(['log', 'refs/heads/main', '--format=%H%x09%ct%x09%s']).catch(
      () => ({ stdout: '' }),
    );
    return result.stdout
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => {
        const [id = '', timestamp = '0', ...subject] = line.split('\t');
        return { id, timestamp: Number(timestamp), message: subject.join('\t') };
      });
  }
  async diff(id: string, file?: string) {
    const args = ['diff-tree', '--root', '-p', id];
    if (file) {
      await this.jail.resolve(file);
      args.push('--', file);
    }
    return (await this.git(args)).stdout;
  }
  async restore(id: string, file?: string): Promise<void> {
    const sha = z
      .string()
      .regex(/^[0-9a-f]{40}$/i)
      .parse(id);
    if (file) {
      const target = await this.jail.resolve(file, { allowMissing: true });
      await fs.mkdir(path.dirname(target), { recursive: true });
      await this.git(['show', `${sha}:${this.jail.relative(target)}`]).then(({ stdout }) =>
        fs.writeFile(target, stdout),
      );
    } else {
      const files = await this.git(['ls-tree', '-r', '--name-only', sha]);
      const keep = new Set(files.stdout.split(/\r?\n/).filter(Boolean));
      const current = await glob('**/*', {
        cwd: this.jail.root,
        dot: true,
        onlyFiles: true,
        ignore: ['.git/**', 'node_modules/**'],
      });
      for (const rel of current) {
        if (!keep.has(rel) && !(await this.jail.isIgnored(path.join(this.jail.root, rel))))
          await fs.rm(await this.jail.resolve(rel), { force: true });
      }
      await this.git(['read-tree', sha]);
      await this.git(['checkout-index', '-a', '-f']);
    }
  }
  private git(args: string[]) {
    return execa(
      'git',
      [
        `--git-dir=${this.dir}`,
        `--work-tree=${this.jail.root}`,
        '-c',
        'user.name=Ferry',
        '-c',
        'user.email=ferry@localhost',
        '-c',
        'core.autocrlf=false',
        ...args,
      ],
      {
        cwd: this.jail.root,
        reject: true,
      },
    );
  }
}
export async function createCheckpoint(raw: unknown, jail: WorkspaceJail): Promise<string> {
  const input = CheckpointInput.parse(raw);
  return new ShadowCheckpoints(jail, input.dataDir).snapshot(input.message);
}
export async function checkpointRestore(raw: unknown, jail: WorkspaceJail): Promise<void> {
  const input = RestoreCheckpointInput.parse(raw);
  return new ShadowCheckpoints(jail, input.dataDir).restore(input.id, input.path);
}

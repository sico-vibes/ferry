import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { copyStorageMigrations } from '../scripts/copy-migrations.js';

const testDirectory = dirname(fileURLToPath(import.meta.url));
const migrationDirectory = join(testDirectory, '../src/migrations');
const rootDirectory = join(testDirectory, '../../..');
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) =>
        rm(directory, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 }),
      ),
  );
});

async function makeOutputDirectory(name: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), `ferry-${name}-migrations-`));
  temporaryDirectories.push(root);
  return root;
}

async function expectAllMigrationsCopied(outputDirectory: string): Promise<void> {
  const sourceFiles = (await readdir(migrationDirectory)).filter((file) => file.endsWith('.sql'));
  const copiedFiles = (await readdir(outputDirectory)).filter((file) => file.endsWith('.sql'));
  expect(copiedFiles.sort()).toEqual([...sourceFiles].sort());
  await Promise.all(
    sourceFiles.map(async (file) => {
      await expect(readFile(join(outputDirectory, file), 'utf8')).resolves.toBe(
        await readFile(join(migrationDirectory, file), 'utf8'),
      );
    }),
  );
}

describe('migration build targets', () => {
  it('copies every SQL migration into the Electron main output', async () => {
    const output = join(await makeOutputDirectory('desktop'), 'out', 'main', 'migrations');
    await copyStorageMigrations(migrationDirectory, output);
    await expectAllMigrationsCopied(output);

    const config = await readFile(
      join(rootDirectory, 'apps/desktop/electron.vite.config.ts'),
      'utf8',
    );
    expect(config).toContain('copyStorageMigrations');
    expect(config).toContain("resolve('out/main/migrations')");
  }, 30_000);

  it('copies every SQL migration into the CLI bundle output', async () => {
    const output = join(await makeOutputDirectory('cli'), 'dist', 'migrations');
    await copyStorageMigrations(migrationDirectory, output);
    await expectAllMigrationsCopied(output);

    const config = await readFile(join(rootDirectory, 'apps/cli/tsup.config.ts'), 'utf8');
    expect(config).toContain('copyStorageMigrations');
    expect(config).toContain("'dist/migrations'");
  }, 30_000);

  it('includes and unpacks all Electron main migrations in packaged builds', async () => {
    const config = await readFile(join(rootDirectory, 'apps/desktop/electron-builder.yml'), 'utf8');
    const distScript = await readFile(join(rootDirectory, 'apps/desktop/scripts/dist.mjs'), 'utf8');
    expect(config).toContain('- out/main/migrations/**');
    expect(config).toContain("- 'out/main/migrations/**'");
    expect(config).toContain('from: out/cli');
    expect(config).toContain('to: cli');
    expect(distScript).toContain("'apps/cli/dist'");
    expect(distScript).toContain('cliOutput');
  });
});

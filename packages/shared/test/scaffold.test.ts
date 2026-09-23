import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

const packageDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(packageDirectory, '../../..');
const workspacePackageNames = ['shared', 'client', 'ui'] as const;

const PackageJsonSchema = z.object({
  exports: z.record(z.string(), z.string()).optional(),
});
const RootManifestSchema = z.object({
  packageManager: z.string().optional(),
});

function readJsonFile(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8')) as unknown;
}

function readPackageJson(packageName: string): z.infer<typeof PackageJsonSchema> {
  return PackageJsonSchema.parse(
    readJsonFile(resolve(repositoryRoot, 'packages', packageName, 'package.json')),
  );
}

describe('package exports point to existing files', () => {
  for (const packageName of workspacePackageNames) {
    it(`@ferry/${packageName} exports existing entry points`, () => {
      const manifest = readPackageJson(packageName);
      const targets = Object.values(manifest.exports ?? {});
      expect(targets.length).toBeGreaterThan(0);
      for (const target of targets) {
        const targetPath = resolve(repositoryRoot, 'packages', packageName, target);
        expect(existsSync(targetPath), target).toBe(true);
      }
    });
  }
});

describe('per-package typecheck passes', () => {
  const tscEntry = resolve(repositoryRoot, 'node_modules/typescript/bin/tsc');

  for (const packageName of workspacePackageNames) {
    it(`@ferry/${packageName} passes tsc --noEmit`, { timeout: 120_000 }, () => {
      const result = spawnSync(
        process.execPath,
        [
          tscEntry,
          '--noEmit',
          '-p',
          resolve(repositoryRoot, 'packages', packageName, 'tsconfig.json'),
        ],
        { cwd: repositoryRoot, encoding: 'utf8' },
      );
      expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
    });
  }
});

describe('CI workflow', () => {
  const workflow = readFileSync(resolve(repositoryRoot, '.github/workflows/ci.yml'), 'utf8');

  it('is a well-formed YAML document using space indentation', () => {
    expect(workflow.length).toBeGreaterThan(0);
    expect(workflow).not.toMatch(/\t/);
    expect(workflow).toMatch(/^name:\s*\S+/m);
    expect(workflow).toMatch(/^on:/m);
    expect(workflow).toMatch(/^jobs:/m);
  });

  it('runs on both windows-latest and ubuntu-latest', () => {
    expect(workflow).toMatch(/os:\s*\[[^\]]*\bwindows-latest\b[^\]]*\]/);
    expect(workflow).toMatch(/os:\s*\[[^\]]*\bubuntu-latest\b[^\]]*\]/);
    expect(workflow).toMatch(/runs-on:\s*\$\{\{\s*matrix\.os\s*\}\}/);
  });

  it('installs with a frozen lockfile, runs pnpm check, and uses Node 24', () => {
    expect(workflow).toMatch(/pnpm install --frozen-lockfile/);
    expect(workflow).toMatch(/^\s*-\s*run:\s*pnpm check\s*$/m);
    expect(workflow).toMatch(/node-version:\s*24\b/);
  });

  it('pins the pnpm version to the repository packageManager', () => {
    const rootManifest = RootManifestSchema.parse(
      readJsonFile(resolve(repositoryRoot, 'package.json')),
    );
    const pinned = /^pnpm@(.+)$/.exec(rootManifest.packageManager ?? '');
    expect(pinned?.[1], 'packageManager should be pnpm@<version>').toBeDefined();
    expect(workflow).toContain(`version: ${pinned?.[1] ?? ''}`);
  });
});

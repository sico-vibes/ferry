import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { deriveCliBundleInputs } from './bundle-inputs.js';

const cliDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const rootDirectory = resolve(cliDirectory, '../..');

describe('CLI bundle freshness inputs', () => {
  it('covers the source and manifest for every transitive workspace dependency', () => {
    const { inputs, workspacePackages } = deriveCliBundleInputs(rootDirectory);
    const inputSet = new Set(inputs);
    const packageNames = new Set(workspacePackages.map(({ name }) => name));

    expect(packageNames).toContain('@ferry/core');
    expect(workspacePackages.length).toBeGreaterThan(1);
    for (const workspacePackage of workspacePackages) {
      expect(inputSet).toContain(join(workspacePackage.directory, 'src'));
      expect(inputSet).toContain(join(workspacePackage.directory, 'package.json'));
    }
  });
});

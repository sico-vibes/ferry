import { betaVersionForRunNumber } from './release-config.mjs';

const runNumber = Number(process.argv[2] ?? process.env.GITHUB_RUN_NUMBER);
process.stdout.write(`${betaVersionForRunNumber(runNumber)}\n`);

import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    passWithNoTests: true,
    // The core suite loads the full provider catalog and spawns fake CLIs/MCP
    // servers. Running one worker per file saturates the CPU and makes the
    // existing host.test.ts contract miss its 5s RPC/session timeout.
    maxWorkers: 2,
  },
});

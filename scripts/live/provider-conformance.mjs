import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { options } from '../bench/lib/options.mjs';
import { withLive } from '../bench/lib/live.mjs';
import { metrics, freeModels } from '../bench/lib/metrics.mjs';
import { report } from '../bench/lib/report.mjs';
import { waitFor } from '../bench/lib/process.mjs';
import { withLargeReply } from '../bench/lib/large-reply.mjs';

try {
  const opts = options(process.argv.slice(2), true);
  if (opts.help)
    console.log(
      'Usage: node scripts/live/provider-conformance.mjs [--profile Auto-Free] [--cli <ferry.js|ferry.cmd>]\n  (--keys-from-env | --use-stored-keys) [--out conformance/report.json] [--help]',
    );
  else {
    const rows = [];
    try {
      await withLive(opts, async (live) => {
        if (live.skipped) {
          rows.push({ provider: '-', model: '-', status: 'skipped', reason: live.skipped });
          return;
        }
        await live.attachedCore();
        let listed = await live.invoke(['providers', 'list', '--json']);
        let replyBytes = Buffer.byteLength(listed.stdout);
        if (listed.code !== 0 || listed.timedOut) {
          rows.push({
            provider: '*',
            model: 'providers.list (attached core)',
            status: 'fail',
            failureKind: 'local_control',
            durationMs: listed.durationMs,
            cliExitCode: listed.code,
            replyBytes,
            reason: listed.stderr || 'Provider list failed',
          });
          return;
        }
        let providers;
        try {
          providers = JSON.parse(listed.stdout);
          assert(Array.isArray(providers));
        } catch {
          rows.push({
            provider: '*',
            model: 'providers.list (attached core)',
            status: 'fail',
            failureKind: 'invalid_json',
            durationMs: listed.durationMs,
            replyBytes,
          });
          return;
        }
        await waitFor(async () => {
          if (
            live.providers.every((id) =>
              providers.some(
                (provider) =>
                  provider.id === id &&
                  (provider.modelsVerifiedAt ||
                    provider.discoveryFailedAt ||
                    provider.discoveryUnsupported ||
                    provider.keyStatus === 'invalid'),
              ),
            )
          )
            return true;
          listed = await live.invoke(['providers', 'list', '--json']);
          assert.equal(listed.code, 0, 'Attached provider list failed while awaiting discovery');
          providers = JSON.parse(listed.stdout);
          return false;
        }, 120_000);
        replyBytes = Buffer.byteLength(listed.stdout);
        rows.push({
          provider: '*',
          model: 'providers.list (attached core)',
          status: 'pass',
          durationMs: listed.durationMs,
          replyBytes,
          largeReplyCovered: replyBytes > 1_000_000,
          reason: `${replyBytes} bytes${replyBytes <= 1_000_000 ? '; catalog reply below 1 MB; large-reply coverage unavailable' : ''}`,
        });
        // Keep exact-provider probes from silently succeeding via another account.
        for (const provider of providers) {
          const disabled = await live.invoke(['providers', 'disable', provider.id, '--json']);
          assert.equal(disabled.code, 0, `Could not isolate provider ${provider.id}`);
        }
        const large = await withLargeReply(live.dataDir, live.providers[0], () =>
          live.invoke(['providers', 'list', '--json']),
        );
        const largeBytes = Buffer.byteLength(large.stdout);
        let largeValid = false;
        try {
          const payload = JSON.parse(large.stdout);
          largeValid = payload.some((provider) =>
            provider.availableModels?.some(
              (model) => model.ref === `${live.providers[0]}/ferry-transport-only`,
            ),
          );
        } catch {
          /* recorded as a conformance failure below */
        }
        rows.push({
          provider: '*',
          model: 'providers.list (>1 MB fixture, attached core)',
          status:
            large.code === 0 && !large.timedOut && largeBytes > 1_000_000 && largeValid
              ? 'pass'
              : 'fail',
          failureKind: large.code === 0 && largeValid ? null : 'local_control',
          durationMs: large.durationMs,
          cliExitCode: large.code,
          replyBytes: largeBytes,
          syntheticTransportFixture: true,
          reason: `${largeBytes} bytes; temporary disabled-provider model metadata restored after probe`,
          stderr: large.stderr,
        });
        await report(opts.out, rows, 'conformance');
        for (const provider of providers.filter((item) => live.providers.includes(item.id))) {
          if (provider.discoveryFailedAt && !provider.modelsVerifiedAt) {
            rows.push({
              provider: provider.id,
              model: 'model discovery',
              status: 'fail',
              failureKind: provider.discoveryErrorClass ?? 'discovery',
              reason: 'Live model discovery failed; no eligible models were available',
            });
            continue;
          }
          const models = freeModels(provider);
          if (!models.length) {
            rows.push({
              provider: provider.id,
              model: '-',
              status: 'skipped',
              reason: 'skipped: no Auto-Free tool-capable models',
            });
            continue;
          }
          const enabled = await live.invoke(['providers', 'enable', provider.id, '--json']);
          assert.equal(enabled.code, 0, `Could not enable ${provider.id}`);
          try {
            for (const model of models) {
              const configured = await live.invoke([
                'profiles',
                'chain',
                'set',
                opts.profile,
                `${provider.id}=${model.ref.slice(provider.id.length + 1)}`,
                '--json',
              ]);
              assert.equal(configured.code, 0, 'Could not configure exact-model chain');
              const roles = await live.invoke([
                'profiles',
                'roles',
                'set',
                opts.profile,
                'off',
                '--json',
              ]);
              assert.equal(roles.code, 0, 'Could not disable role routing');
              const workspace = join(live.temporary, 'conformance');
              await mkdir(workspace, { recursive: true });
              for (let iteration = 1; iteration <= 2; iteration++) {
                await rm(join(workspace, 'roundtrip.txt'), {
                  force: true,
                  maxRetries: 8,
                  retryDelay: 100,
                });
                const marker = `ferry-conformance-${randomUUID()}`;
                const prompt = `Perform exactly three sequential tool calls, one per response, waiting for each result before the next: (1) list_dir for the current directory '.', (2) write_file creating roundtrip.txt containing exactly ${marker}, (3) read_file of roundtrip.txt. Then answer with the content you read. Do not use any other tools. This checks reasoning and tool-result history across turns.`;
                const result = await live.invoke(
                  [
                    'run',
                    prompt,
                    '--json',
                    '--cwd',
                    workspace,
                    '--profile',
                    opts.profile,
                    '--model-ref',
                    model.ref,
                    '--permission',
                    'full_auto',
                    '--max-steps',
                    '8',
                  ],
                  { timeoutMs: 180_000 },
                );
                const parsed = metrics(result.stdout);
                let reason;
                try {
                  assert.equal(result.timedOut, false, 'CLI timed out');
                  assert.equal(result.code, 0, `CLI exited ${result.code}`);
                  assert(parsed.completed && parsed.malformedLines === 0, 'Incomplete JSON run');
                  assert.deepEqual(
                    parsed.toolCalls.map((part) => part.tool),
                    ['list_dir', 'write_file', 'read_file'],
                    'Expected the three sequential tools',
                  );
                  assert(
                    parsed.toolCalls.every((part) => part.status === 'succeeded'),
                    'Tool failed',
                  );
                  assert(
                    parsed.toolCalls.every(
                      (part) => !part.producedBy || part.producedBy === model.ref,
                    ),
                    'Another model served the probe',
                  );
                  assert(
                    parsed.modelsUsed.length > 0 &&
                      parsed.modelsUsed.every((ref) => ref === model.ref),
                    'Selected model did not exclusively serve probe',
                  );
                  assert.equal(
                    (await readFile(join(workspace, 'roundtrip.txt'), 'utf8')).trim(),
                    marker,
                    'Written content mismatch',
                  );
                  assert(
                    parsed.toolCalls.at(-1).output?.text.includes(marker),
                    'Read tool did not round-trip written content',
                  );
                  const events = result.stdout
                    .split(/\r?\n/)
                    .filter(Boolean)
                    .map((line) => JSON.parse(line));
                  assert(
                    events.some(
                      (event) => event.part?.type === 'text' && event.part.text.includes(marker),
                    ),
                    'Final answer did not contain read content',
                  );
                } catch (error) {
                  reason = error.message;
                }
                const failure = parsed.attempts.findLast(
                  (attempt) => attempt.errorKind || attempt.fallbackReason,
                );
                rows.push({
                  provider: provider.id,
                  model: model.ref,
                  run: iteration,
                  status: reason ? 'fail' : 'pass',
                  failureKind: reason
                    ? result.timedOut
                      ? 'timeout'
                      : (failure?.errorKind ?? failure?.fallbackReason ?? 'conformance')
                    : null,
                  statusCode: failure?.status ?? parsed.attempts.at(-1)?.status ?? null,
                  durationMs: result.durationMs,
                  cliExitCode: result.code,
                  reason,
                  ...parsed,
                  stderr: result.stderr,
                });
                console.log(
                  `${provider.id} ${model.ref} #${iteration}: ${reason ? 'fail' : 'pass'}`,
                );
                await report(opts.out, rows, 'conformance');
              }
            }
          } finally {
            await live.invoke(['providers', 'disable', provider.id, '--json']);
          }
        }
      });
    } catch (error) {
      rows.push({
        provider: '*',
        model: 'runner',
        status: 'fail',
        failureKind: 'infrastructure',
        reason: error.message,
      });
      throw error;
    } finally {
      await report(opts.out, rows, 'conformance');
    }
    if (rows.some((row) => row.status === 'fail')) process.exitCode = 1;
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}

import { describe, expect, it } from 'vitest';
import { configuredContent, masked, toolLaunch } from '../src/tool-config.js';

const connection = {
  url: 'http://127.0.0.1:11435',
  secret: 'fixture-launch-secret',
  model: 'openrouter/model',
};
describe('per-process tool configuration', () => {
  it('sets Claude env and preserves literal passthrough args', () => {
    const launch = toolLaunch('claude', connection, ['--print', 'hello & goodbye']);
    expect(launch.args).toEqual(['--print', 'hello & goodbye']);
    expect(launch.env).toEqual({
      ANTHROPIC_BASE_URL: connection.url,
      ANTHROPIC_AUTH_TOKEN: connection.secret,
      ANTHROPIC_MODEL: connection.model,
    });
    expect(JSON.stringify(masked(launch, connection.secret))).not.toContain(connection.secret);
    expect(process.env.ANTHROPIC_AUTH_TOKEN).not.toBe(connection.secret);
  });
  it('uses Codex Responses provider overrides with an env key and no secret in args', () => {
    const launch = toolLaunch('codex', connection, ['exec', 'hello']);
    expect(launch.args).toContain(`model_providers.ferry.base_url="${connection.url}/v1"`);
    expect(launch.args).toContain('model_providers.ferry.wire_api="responses"');
    expect(launch.args).toContain('model_providers.ferry.env_key="FERRY_GATEWAY_API_KEY"');
    expect(launch.args.slice(-2)).toEqual(['exec', 'hello']);
    expect(launch.args.join(' ')).not.toContain(connection.secret);
    expect(launch.env.FERRY_GATEWAY_API_KEY).toBe(connection.secret);
  });
  it('uses OpenCode inline config and masks its nested credential', () => {
    const launch = toolLaunch('opencode', connection);
    expect(JSON.parse(launch.env.OPENCODE_CONFIG_CONTENT ?? '{}')).toMatchObject({
      model: 'ferry/openrouter/model',
      provider: {
        ferry: { options: { baseURL: `${connection.url}/v1`, apiKey: connection.secret } },
      },
    });
    expect(JSON.stringify(masked(launch, connection.secret))).not.toContain(connection.secret);
  });
  it('preserves unrelated Claude and OpenCode config', () => {
    expect(
      JSON.parse(
        configuredContent(
          'claude',
          connection,
          '{"permissions":{"allow":["Read"]},"env":{"CUSTOM":"yes"}}',
        ),
      ),
    ).toMatchObject({
      permissions: { allow: ['Read'] },
      env: { CUSTOM: 'yes', ANTHROPIC_MODEL: connection.model },
    });
    expect(
      JSON.parse(
        configuredContent(
          'opencode',
          connection,
          '{"theme":"dark","provider":{"other":{"name":"Other"}}}',
        ),
      ),
    ).toMatchObject({
      theme: 'dark',
      provider: { other: { name: 'Other' }, ferry: { name: 'Ferry' } },
    });
  });
  it('replaces only the Codex root selection and Ferry provider, preserving other tables', () => {
    const existing =
      'model = "old"\nmodel_provider = "old"\napproval_policy = "on-request"\n\n[model_providers.ferry]\nname = "Old"\nbase_url = "http://old"\n\n[projects."D:/project"]\ntrust_level = "trusted"\n';
    const content = configuredContent('codex', connection, existing);
    expect(content).toContain('approval_policy = "on-request"');
    expect(content).toContain('[projects."D:/project"]\ntrust_level = "trusted"');
    expect(content).not.toContain('http://old');
    expect(content.match(/\[model_providers\.ferry\]/g)).toHaveLength(1);
    expect(configuredContent('codex', connection, content)).toBe(content);
  });
});

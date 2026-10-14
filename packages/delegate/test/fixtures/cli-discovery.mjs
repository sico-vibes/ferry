// Offline fixture for installed-CLI discovery. Mode is chosen from argv:
//   auth status --json   -> Claude auth status JSON
//   models --verbose     -> OpenCode verbose model list
//   contains --input-format -> Claude structured control (NDJSON control_request on stdin)
//   (no args)            -> Codex app-server headerless JSON-RPC on stdio
//
// The Claude scenario is selected by FERRY_CLAUDE_FIXTURE so auth/billing regressions can be
// exercised without a real CLI, credentials, or generation.
const args = process.argv.slice(2);
const claudeMode = process.env.FERRY_CLAUDE_FIXTURE ?? 'default';

const claudeModels = [
  {
    value: 'default',
    resolvedModel: 'claude-haiku-5-5',
    displayName: 'Default (recommended)',
    description: 'Haiku 5.5',
    supportsEffort: true,
    supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
    supportsAdaptiveThinking: true,
    supportsAutoMode: true,
  },
  {
    value: 'opus',
    resolvedModel: 'claude-opus-5-5',
    displayName: 'Opus 5.5',
    description: 'For complex work and everyday tasks',
    supportsEffort: true,
    supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
    supportsAdaptiveThinking: true,
    supportsFastMode: true,
    supportsAutoMode: true,
  },
];

function claudeAuthJson() {
  switch (claudeMode) {
    case 'signed-out':
      return {
        loggedIn: false,
        authMethod: null,
        apiProvider: null,
        subscriptionType: null,
        email: null,
        orgId: null,
        orgName: null,
        apiKeySource: null,
      };
    case 'api-key':
      return {
        loggedIn: true,
        authMethod: 'apiKey',
        apiProvider: 'firstParty',
        subscriptionType: 'pro',
        email: 'dev@example.com',
        orgId: 'org-fixture-1',
        orgName: 'Fixture Org',
        apiKeySource: 'project',
      };
    case 'bedrock':
      return {
        loggedIn: true,
        authMethod: 'claude.ai',
        apiProvider: 'bedrock',
        subscriptionType: 'pro',
        email: 'dev@example.com',
        orgId: 'org-fixture-1',
        orgName: 'Fixture Org',
        apiKeySource: null,
      };
    case 'vertex':
      return {
        loggedIn: true,
        authMethod: 'claude.ai',
        apiProvider: 'vertex',
        subscriptionType: 'pro',
        email: 'dev@example.com',
        orgId: 'org-fixture-1',
        orgName: 'Fixture Org',
        apiKeySource: null,
      };
    case 'org-a':
      return {
        loggedIn: true,
        authMethod: 'claude.ai',
        apiProvider: 'firstParty',
        subscriptionType: 'pro',
        email: 'a@example.com',
        orgId: 'shared-org',
        orgName: 'Shared Org',
        apiKeySource: null,
      };
    case 'org-b':
      return {
        loggedIn: true,
        authMethod: 'claude.ai',
        apiProvider: 'firstParty',
        subscriptionType: 'pro',
        email: 'b@example.com',
        orgId: 'shared-org',
        orgName: 'Shared Org',
        apiKeySource: null,
      };
    default:
      return {
        loggedIn: true,
        authMethod: 'claude.ai',
        apiProvider: 'firstParty',
        subscriptionType: 'pro',
        email: 'dev@example.com',
        orgId: 'org-fixture-1',
        orgName: 'Fixture Org',
        apiKeySource: null,
      };
  }
}

const claudeAuthUnavailable = claudeMode === 'unavailable' || claudeMode === 'account-null';

function claudeAccount() {
  if (claudeMode === 'signed-out' || claudeMode === 'account-null' || claudeMode === 'unavailable')
    return null;
  const status = claudeAuthJson();
  return {
    email: status.email,
    organization: status.orgName ?? status.orgId,
    subscriptionType: 'Claude Pro',
    apiProvider: status.apiProvider,
  };
}

const claudeUsageResponse = {
  subscription_type: 'pro',
  rate_limits_available: true,
  rate_limits: {
    five_hour: { utilization: 65, resets_at: '2026-10-13T23:59:59.507631+00:00' },
    seven_day: { utilization: 62, resets_at: '2026-10-15T16:59:59.507650+00:00' },
    seven_day_opus: null,
    seven_day_sonnet: null,
    extra_usage: { is_enabled: false, utilization: null },
    model_scoped: [],
  },
};

if (args[0] === 'auth' && args[1] === 'status') {
  if (claudeAuthUnavailable) process.exit(3);
  process.stdout.write(`${JSON.stringify(claudeAuthJson())}\n`);
} else if (args[0] === 'models') {
  const model = {
    id: 'deepseek-v4.1-flash',
    providerID: 'opencode-go',
    name: 'DeepSeek V4.1 Flash',
    cost: { input: 0, output: 0 },
    capabilities: { toolcall: true, reasoning: true },
    variants: {
      low: { reasoningEffort: 'low' },
      high: { reasoningEffort: 'high' },
      max: { reasoningEffort: 'max' },
    },
  };
  process.stdout.write(`opencode-go/deepseek-v4.1-flash\n${JSON.stringify(model, null, 2)}\n`);
} else if (args.includes('--input-format')) {
  let buffer = '';
  const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
  process.stdin.on('data', (chunk) => {
    buffer += chunk;
    for (;;) {
      const index = buffer.indexOf('\n');
      if (index < 0) return;
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (!line) continue;
      let request;
      try {
        request = JSON.parse(line);
      } catch {
        continue;
      }
      if (request?.type !== 'control_request') continue;
      const requestId = request.request_id;
      const subtype = request.request?.subtype;
      if (subtype === 'initialize') {
        if (claudeMode === 'unavailable') {
          send({
            type: 'control_response',
            response: { request_id: requestId, subtype: 'error', error: 'control unavailable' },
          });
        } else {
          send({
            type: 'control_response',
            response: {
              request_id: requestId,
              subtype: 'success',
              response: {
                models: claudeModels,
                account: claudeAccount(),
                claude_code_version: '2.1.296-fixture',
              },
            },
          });
        }
      } else if (subtype === 'get_usage') {
        send({
          type: 'control_response',
          response: { request_id: requestId, subtype: 'success', response: claudeUsageResponse },
        });
      } else {
        send({
          type: 'control_response',
          response: { request_id: requestId, subtype: 'error', error: 'unsupported' },
        });
      }
    }
  });
  process.stdin.on('end', () => process.exit(0));
} else {
  let buffer = '';
  const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
  const handle = (request) => {
    const { id, method } = request;
    if (method === 'initialize') {
      send({
        id,
        result: {
          codexHome: '/tmp/codex',
          platformFamily: 'unix',
          platformOs: 'linux',
          userAgent: 'ferry-fixture',
        },
      });
    } else if (method === 'model/list') {
      send({
        id,
        result: {
          data: [
            {
              id: 'gpt-5.1-codex',
              model: 'gpt-5.1-codex',
              displayName: 'GPT-5.1 Codex',
              description: '',
              hidden: false,
              isDefault: true,
              inputModalities: ['text', 'image'],
              defaultReasoningEffort: 'medium',
              supportedReasoningEfforts: [
                { reasoningEffort: 'low', description: '' },
                { reasoningEffort: 'medium', description: '' },
                { reasoningEffort: 'high', description: '' },
                { reasoningEffort: 'xhigh', description: '' },
                { reasoningEffort: 'ultra', description: 'Automatic task delegation' },
              ],
              serviceTiers: [{ id: 'priority', name: 'Fast', description: '2x speed' }],
            },
          ],
          nextCursor: null,
        },
      });
    } else if (method === 'account/read') {
      send({
        id,
        result: {
          account: { type: 'chatgpt', email: 'dev@example.com', planType: 'pro' },
          requiresOpenaiAuth: false,
        },
      });
    } else if (method === 'account/rateLimits/read') {
      send({
        id,
        result: {
          accountId: 'acct-fixture-1',
          rateLimits: {
            limitId: 'codex',
            limitName: 'Codex',
            planType: 'pro',
            primary: { usedPercent: 42, resetsAt: 1_893_456_000, windowDurationMins: 300 },
            secondary: { usedPercent: 10, resetsAt: 1_894_000_000, windowDurationMins: 10_080 },
          },
          rateLimitsByLimitId: {
            codex: {
              limitId: 'codex',
              limitName: 'Codex',
              planType: 'pro',
              primary: { usedPercent: 65, resetsAt: 1_893_456_000, windowDurationMins: 300 },
              secondary: { usedPercent: 11, resetsAt: 1_894_000_000, windowDurationMins: 10_080 },
            },
            'codex-mini': {
              limitId: 'codex-mini',
              limitName: 'Codex Mini',
              planType: 'pro',
              primary: { usedPercent: 130, resetsAt: 1_893_500_000, windowDurationMins: 300 },
            },
          },
        },
      });
    } else {
      send({ id, error: { code: -32601, message: 'unsupported' } });
    }
  };

  process.stdin.on('data', (chunk) => {
    buffer += chunk;
    for (;;) {
      const index = buffer.indexOf('\n');
      if (index < 0) return;
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (line) handle(JSON.parse(line));
    }
  });
  process.stdin.on('end', () => process.exit(0));
}

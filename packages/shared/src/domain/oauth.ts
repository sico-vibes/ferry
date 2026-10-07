import { z } from 'zod';

export const KNOWN_OAUTH_PROVIDER_IDS = [
  'anthropic',
  'openai-codex',
  'github-copilot',
  'openrouter',
  'kimi-coding',
  'meta',
  'xai',
  'radius',
  'kilo',
  'qoder',
  'cline',
  'gemini-cli',
  'antigravity',
] as const;
export const OAuthProviderIdSchema = z.string().regex(/^[a-z0-9][a-z0-9-]*$/);
export type OAuthProviderId = z.infer<typeof OAuthProviderIdSchema>;
export const OAuthProviderRiskSchema = z.enum(['low', 'medium', 'high']);
export const OAuthProviderGroupSchema = z.enum([
  'official',
  'subscription',
  'gateway',
  'coming_soon',
  'unavailable',
]);
export const OAuthProviderSchema = z.object({
  id: OAuthProviderIdSchema,
  tag: z.enum(['legit', 'subscription_oauth']),
  name: z.string(),
  subscriptionRequired: z.boolean(),
  models: z.array(z.string()),
  riskLevel: OAuthProviderRiskSchema,
  riskText: z.string(),
  connected: z.boolean(),
  status: z.enum(['not_connected', 'connected', 'expired', 'unavailable']).optional(),
  reason: z.string().optional(),
  account: z.string().nullable().optional(),
  group: OAuthProviderGroupSchema.optional(),
  actionAvailable: z.boolean().optional(),
  advanced: z.boolean().optional(),
  signupUrl: z.url().nullable().optional(),
});
export type OAuthProvider = z.infer<typeof OAuthProviderSchema>;
export const OAuthLoginProgressSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('open_url'),
    id: OAuthProviderIdSchema,
    url: z.url(),
    instructions: z.string().optional(),
  }),
  z.object({
    type: z.literal('device_code'),
    id: OAuthProviderIdSchema,
    userCode: z.string(),
    verificationUri: z.url(),
    expiresInSeconds: z.number().positive().optional(),
  }),
  z.object({ type: z.literal('success'), id: OAuthProviderIdSchema }),
  z.object({ type: z.literal('error'), id: OAuthProviderIdSchema, message: z.string() }),
]);
export type OAuthLoginProgress = z.infer<typeof OAuthLoginProgressSchema>;

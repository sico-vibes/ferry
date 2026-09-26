import { z } from 'zod';

export const OAuthProviderIdSchema = z.enum(['anthropic', 'openai-codex', 'github-copilot']);
export type OAuthProviderId = z.infer<typeof OAuthProviderIdSchema>;
export const OAuthProviderSchema = z.object({
  id: OAuthProviderIdSchema,
  tag: z.literal('subscription_oauth'),
  name: z.string(),
  subscriptionRequired: z.literal(true),
  models: z.array(z.string()),
  riskLevel: z.literal('high'),
  riskText: z.string(),
  connected: z.boolean(),
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

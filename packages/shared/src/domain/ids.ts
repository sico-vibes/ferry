import { z } from 'zod';

const idSchema = <const T extends string>(_brand: T) => z.string().min(1).brand<T>();
export const WorkspaceIdSchema = idSchema('WorkspaceId');
export type WorkspaceId = z.infer<typeof WorkspaceIdSchema>;
export const SessionIdSchema = idSchema('SessionId');
export type SessionId = z.infer<typeof SessionIdSchema>;
export const MessageIdSchema = idSchema('MessageId');
export type MessageId = z.infer<typeof MessageIdSchema>;
export const PartIdSchema = idSchema('PartId');
export type PartId = z.infer<typeof PartIdSchema>;
export const ProviderIdSchema = idSchema('ProviderId');
export type ProviderId = z.infer<typeof ProviderIdSchema>;
export const ProfileIdSchema = idSchema('ProfileId');
export type ProfileId = z.infer<typeof ProfileIdSchema>;
export const RunIdSchema = idSchema('RunId');
export type RunId = z.infer<typeof RunIdSchema>;
export const CheckpointIdSchema = idSchema('CheckpointId');
export type CheckpointId = z.infer<typeof CheckpointIdSchema>;
export const McpServerIdSchema = idSchema('McpServerId');
export type McpServerId = z.infer<typeof McpServerIdSchema>;
export const SkillIdSchema = idSchema('SkillId');
export type SkillId = z.infer<typeof SkillIdSchema>;
export const ModelRefSchema = z
  .string()
  .regex(/^[a-z0-9][a-z0-9._-]*\/.+$/)
  .brand<'ModelRef'>();
export type ModelRef = z.infer<typeof ModelRefSchema>;

const base36 = '0123456789abcdefghijklmnopqrstuvwxyz';
export function newId(prefix: string): string {
  if (!prefix.trim()) throw new Error('ID prefix must not be empty');
  const bytes = new Uint8Array(20);
  globalThis.crypto.getRandomValues(bytes);
  return `${prefix}_${Array.from(bytes, (byte) => base36[byte % 36]).join('')}`;
}

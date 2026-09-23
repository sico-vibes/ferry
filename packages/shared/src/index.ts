import { z } from 'zod';

export const FERRY_PROTOCOL_VERSION = 'ferry/1';
export const WorkspaceIdSchema = z.string().min(1).brand<'WorkspaceId'>();
export type WorkspaceId = z.infer<typeof WorkspaceIdSchema>;

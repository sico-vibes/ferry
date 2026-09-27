import { z } from 'zod';

export const EmptyIpcArgsSchema = z.tuple([]);
export const OpenFolderResultSchema = z.string().min(1).nullable();
export const DesktopThemeSchema = z.enum(['dark', 'light']);
export const CoreHandoffTokenSchema = z.string().regex(/^[a-f0-9]{64}$/i);

import { z } from 'zod';
export const OptimizerStatsSchema = z.object({
  demo: z.boolean(),
  today: z.object({
    savedTokens: z.number().nonnegative(),
    percent: z.number().min(0).max(100),
    samples: z.number().int().nonnegative(),
  }),
  cavemanLastRun: z
    .object({
      runId: z.string().optional(),
      sessionId: z.string(),
      savedTokens: z.number().nonnegative(),
      percent: z.number().min(0).max(100),
      samples: z.number().int().nonnegative(),
    })
    .nullable()
    .optional(),
  byOptimizer: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      enabled: z.boolean(),
      savedTokens: z.number().nonnegative(),
      percent: z.number().min(0).max(100),
    }),
  ),
});
export type OptimizerStats = z.infer<typeof OptimizerStatsSchema>;

import type { FileChange, ModelRef, ToolName, ToolOutput } from '@ferry/shared';

export type Step =
  | { kind: 'think'; ms: number }
  | { kind: 'text'; text: string; chunkMs?: number }
  | { kind: 'reasoning'; text: string }
  | {
      kind: 'plan';
      items: { text: string; status: 'todo' | 'doing' | 'done' | 'blocked' }[];
      goal?: string;
      nextStep?: string;
    }
  | {
      kind: 'tool';
      tool: ToolName;
      title: string;
      args: Record<string, unknown>;
      runMs: number;
      output?: ToolOutput;
      changes?: FileChange[];
      touched?: { path: string; purpose: string }[];
      denied?: boolean;
    }
  | {
      kind: 'approval';
      approvalKind?: 'command' | 'edit' | 'delegation' | 'paid_model';
      summary: string;
      detail: string;
      risk: 'low' | 'medium' | 'high';
      then: Step[];
      ifDenied: Step[];
    }
  | {
      kind: 'handoff';
      from: ModelRef;
      to: ModelRef;
      reason: 'quota' | 'rate_limit' | 'error' | 'context' | 'capability' | 'manual';
      briefingTokens: number;
      explanation: string;
    }
  | { kind: 'delegation'; lane: string; brief: string }
  | { kind: 'checkpoint'; label: string }
  | { kind: 'capacity'; steps: number }
  | { kind: 'error'; message: string; errorKind: 'provider' | 'tool' | 'permission' | 'internal' };

export interface Scenario {
  id: string;
  match: RegExp;
  title: string;
  steps: Step[];
}

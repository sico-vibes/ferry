export function driveEvalSession(input: {
  client: unknown;
  prompt: string;
  cwd: string;
  profileName: string;
  modelRef?: string;
  maxSteps: number;
  verbose?: boolean;
  timeoutMs?: number;
  inactivityTimeoutMs?: number;
  logDirectory?: string;
  secrets?: readonly string[];
  onProgress?: (event: unknown) => void;
}): Promise<{
  exitCode: number;
  session: { id: string; status: string };
  detail: {
    session: { id: string; status: string };
    messages: { role: string; parts: { type: string; text?: string }[] }[];
    taskRecord?: { steps: unknown[] };
  };
  eventTail: string[];
}>;

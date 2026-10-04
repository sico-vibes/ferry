export interface StageCliRuntimeOptions {
  sourceDirectory: string;
  targetDirectory: string;
}

export function stageCliRuntime(options: StageCliRuntimeOptions): Promise<void>;

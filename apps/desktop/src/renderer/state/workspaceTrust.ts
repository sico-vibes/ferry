import { create } from 'zustand';

export interface TrustRequest {
  workspaceId: string;
  name: string;
  path: string;
  riskyRoot: boolean;
}

interface TrustPromptState {
  pending: (TrustRequest & { resolve: (trusted: boolean) => void }) | null;
  /** Ask the user to trust a folder; resolves true when they trust it. */
  request: (input: TrustRequest) => Promise<boolean>;
  answer: (trusted: boolean) => void;
}

export const useWorkspaceTrust = create<TrustPromptState>((set, get) => ({
  pending: null,
  request: (input) =>
    new Promise<boolean>((resolve) => {
      get().pending?.resolve(false);
      set({ pending: { ...input, resolve } });
    }),
  answer: (trusted) => {
    get().pending?.resolve(trusted);
    set({ pending: null });
  },
}));

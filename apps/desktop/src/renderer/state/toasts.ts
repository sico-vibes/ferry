import { create } from 'zustand';

export interface Toast {
  id: number;
  kind: 'info' | 'success' | 'warning' | 'error';
  title: string;
  body: string | null;
}
interface ToastState {
  items: Toast[];
  push: (toast: Omit<Toast, 'id'>, key?: string) => void;
  dismiss: (id: number) => void;
}
let nextId = 1;
export const useToasts = create<ToastState>((set) => ({
  items: [],
  push: (toast, key = `${toast.kind}:${toast.title}:${toast.body ?? ''}`) => {
    set((state) => {
      const existing = state.items.find((item) => (item as Toast & { key?: string }).key === key);
      const next = { ...toast, id: existing?.id ?? nextId++, key } as Toast & { key: string };
      return {
        items: [
          ...state.items.filter((item) => (item as Toast & { key?: string }).key !== key),
          next,
        ].slice(-4),
      };
    });
  },
  dismiss: (id) => {
    set((state) => ({ items: state.items.filter((toast) => toast.id !== id) }));
  },
}));

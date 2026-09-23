import { create } from 'zustand';

export interface Toast {
  id: number;
  kind: 'info' | 'success' | 'warning' | 'error';
  title: string;
  body: string | null;
}
interface ToastState {
  items: Toast[];
  push: (toast: Omit<Toast, 'id'>) => void;
  dismiss: (id: number) => void;
}
let nextId = 1;
export const useToasts = create<ToastState>((set) => ({
  items: [],
  push: (toast) => {
    set((state) => ({ items: [...state.items, { ...toast, id: nextId++ }].slice(-4) }));
  },
  dismiss: (id) => {
    set((state) => ({ items: state.items.filter((toast) => toast.id !== id) }));
  },
}));

import type { ReactNode } from 'react';
import '../src/fonts';
import '../src/styles/index.css';

export const Provider = ({ children }: { children: ReactNode }) => (
  <div className="flex min-h-screen items-center justify-center bg-app p-6 text-text-1">
    {children}
  </div>
);

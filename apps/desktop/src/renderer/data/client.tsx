import { createContext, useContext, type ReactNode } from 'react';
import type { FerryClient } from '@ferry/client';

const FerryContext = createContext<FerryClient | null>(null);

export function FerryProvider({ client, children }: { client: FerryClient; children: ReactNode }) {
  return <FerryContext.Provider value={client}>{children}</FerryContext.Provider>;
}

export function useFerryClient(): FerryClient {
  const client = useContext(FerryContext);
  if (!client) throw new Error('FerryProvider is missing');
  return client;
}

export interface FerryClient {
  readonly protocolVersion: string;
}

export function describeClient(c: FerryClient): string {
  return `Ferry client protocol ${c.protocolVersion}`;
}

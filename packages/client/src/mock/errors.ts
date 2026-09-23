export class MockNotFoundError extends Error {
  constructor(entity: string, id: string) {
    super(`${entity} not found: ${id}`);
    this.name = 'MockNotFoundError';
  }
}

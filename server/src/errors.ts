/** Thrown by stubs until the behaviour is implemented (TDD: tests are written first). */
export class NotImplementedError extends Error {
  constructor(what: string) {
    super(`Not implemented: ${what}`);
    this.name = 'NotImplementedError';
  }
}

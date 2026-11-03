/** Thrown by contract stubs until the behaviour is implemented (TDD red stage); never part of runtime behaviour. */
export class NotImplementedError extends Error {
  constructor(what: string) {
    super(`Not implemented: ${what}`);
    this.name = 'NotImplementedError';
  }
}

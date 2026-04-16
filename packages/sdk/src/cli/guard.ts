export class GuardRejection extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GuardRejection';
  }
}

export function rejectWkInArgv(argv: readonly string[]): void {
  for (const token of argv) {
    if (/wk_[A-Za-z0-9_]+/.test(token)) {
      throw new GuardRejection(
        'refusing to accept wk_ on command line — use credentials file or env vars',
      );
    }
  }
}

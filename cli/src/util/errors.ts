export class CliError extends Error {
  readonly code: string;
  readonly exitCode: number;

  constructor(message: string, options: { code?: string; exitCode?: number } = {}) {
    super(message);
    this.name = 'CliError';
    this.code = options.code ?? 'CLI_ERROR';
    this.exitCode = options.exitCode ?? 1;
  }
}

export function isCliError(error: unknown): error is CliError {
  return error instanceof CliError;
}

export class FormatError extends Error {
  readonly code: string;
  readonly detail: string;

  constructor(code: string, detail = '') {
    super(detail || code);
    this.name = 'FormatError';
    this.code = code;
    this.detail = detail;
  }
}

export function isFileReadError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    typeof error.code === 'string' &&
    error.code.startsWith('FILE_')
  );
}

export function isAbortError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'name' in error &&
    error.name === 'AbortError'
  );
}

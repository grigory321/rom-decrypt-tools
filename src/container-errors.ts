export function errorCode(error: unknown): string {
  return error !== null &&
    typeof error === 'object' &&
    'code' in error &&
    typeof error.code === 'string'
    ? error.code
    : '';
}

export function errorDetail(error: unknown): string {
  return error !== null &&
    typeof error === 'object' &&
    'detail' in error &&
    typeof error.detail === 'string'
    ? error.detail
    : '';
}

export function errorName(error: unknown): string {
  return error !== null &&
    typeof error === 'object' &&
    'name' in error &&
    typeof error.name === 'string'
    ? error.name
    : '';
}

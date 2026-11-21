export function getPgErrorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) {
    return undefined;
  }
  const err = error as { code?: unknown; cause?: unknown };
  if (typeof err.code === 'string') {
    return err.code;
  }
  if (err.cause && typeof err.cause === 'object') {
    const causeCode = (err.cause as { code?: unknown }).code;
    if (typeof causeCode === 'string') {
      return causeCode;
    }
  }
  return undefined;
}

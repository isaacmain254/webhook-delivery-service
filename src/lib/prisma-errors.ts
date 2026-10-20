/** Returns a Prisma known-request error code without importing the runtime class. */
export function prismaErrorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) {
    return undefined
  }

  const code = (error as { code?: unknown }).code
  return typeof code === 'string' && /^P\d{4}$/.test(code) ? code : undefined
}

export function isUniqueConstraintError(error: unknown): boolean {
  return prismaErrorCode(error) === 'P2002'
}

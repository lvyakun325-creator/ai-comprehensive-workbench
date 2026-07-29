export function parseStoredCredentials(raw: unknown): Record<string, string>;
export function updateCredential(
  credentials: unknown,
  id: unknown,
  draftValue: unknown,
  clearRequested: boolean,
): Record<string, string>;
export function maskCredential(value: unknown): string;

export interface TimelineCursor {
  receivedAt: Date;
  id: number;
}

export function encodeCursor(row: TimelineCursor): string {
  return Buffer.from(JSON.stringify({ receivedAt: row.receivedAt.getTime(), id: row.id }), 'utf8').toString(
    'base64url',
  );
}

export function decodeCursor(raw: string): TimelineCursor | null {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
    if (typeof parsed !== 'object' || parsed === null) return null;
    const candidate = parsed as { receivedAt?: unknown; id?: unknown };
    if (typeof candidate.receivedAt !== 'number' || !Number.isFinite(candidate.receivedAt)) return null;
    if (typeof candidate.id !== 'number' || !Number.isInteger(candidate.id)) return null;
    return { receivedAt: new Date(candidate.receivedAt), id: candidate.id };
  } catch {
    // Cursors are opaque client input; Buffer.from is lenient with base64, so the
    // realistic failure is JSON.parse — map it to null so the caller answers 400
    // instead of leaking a parse crash.
    return null;
  }
}

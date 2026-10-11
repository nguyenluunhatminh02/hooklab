// Ingest pipeline constants — names from design 03 §0 (BUILD_PLAN §3.4).
// Every value defined exactly once; no other file may redefine these.

export const RATE_LIMIT_WINDOW_MS = 60_000;
export const RATE_LIMIT_MAX = 60;
export const MAX_BODY_BYTES = 1024 * 1024;
export const REPLAY_TIMEOUT_MS = 10_000;
export const RETENTION_DAYS = 7;
export const DEFAULT_SIGNATURE_HEADER = 'X-Hub-Signature-256';
export const SIGNATURE_PREFIX = 'sha256=';

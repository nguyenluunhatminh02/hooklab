// C7 (BUILD_PLAN §0): 6-field, seconds-first expression with an explicit
// timeZone — 03:00 must not drift with the host TZ (the container also runs
// TZ=UTC; belt and braces). Defined here once and consumed by the service,
// the spec pins it field-by-field.
export const RETENTION_CRON_EXPRESSION = '0 0 3 * * *';
export const RETENTION_CRON_NAME = 'retention';
export const RETENTION_CRON_TIME_ZONE = 'UTC';

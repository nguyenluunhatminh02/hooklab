// App-wide constants — design 02 §1.6 + settled proposals (BUILD_PLAN §3.4).
// Every value defined exactly once; no other file may redefine these.

export const TOKEN_BYTES = 32;
export const LIST_LIMIT_DEFAULT = 25;
export const LIST_LIMIT_MAX = 100;
export const PASSWORD_MIN_LENGTH = 8;
export const WORKSPACE_NAME_MAX_LENGTH = 80;
export const JWT_TTL = '12h';
export const BCRYPT_COST = 10;
export const RESPONSE_BODY_MAX_BYTES = 1024 * 1024;
export const MAX_DESTINATION_HEADERS = 20;
export const MS_PER_DAY = 86_400_000;
export const BEARER_PREFIX = 'Bearer ';
// L-4: client x-request-id is trusted only within this charset/length;
// anything else falls back to a freshly generated id (app.module + filter).
export const REQUEST_ID_PATTERN = /^[A-Za-z0-9._-]{1,128}$/;
export const SEARCH_QUERY_MAX_LENGTH = 200;
export const RETENTION_NOTICE = 'records auto-delete after 7 days';

// Auth-local constants. Shared values (JWT_TTL, BCRYPT_COST, PASSWORD_MIN_LENGTH)
// live in common/constants/app.constants.ts and are never redefined here.

/** L-3: pinned so a token signed with another alg (HS512, `none`) is rejected. */
export const JWT_ALGORITHM = 'HS256';

export const TOKEN_TYPE = 'Bearer';

/** bcrypt silently truncates input past 72 bytes — cap it so hashes match inputs. */
export const PASSWORD_MAX_LENGTH = 72;

export const EMAIL_MAX_LENGTH = 254;

/**
 * Single failure message for unknown-email AND wrong-password: any difference
 * between the two responses would let an attacker enumerate registered emails.
 */
export const INVALID_CREDENTIALS_MESSAGE = 'invalid email or password';

/**
 * Valid bcrypt hash of a throwaway string. The unknown-email path runs a full
 * bcrypt.compare against it so both login failures cost the same wall-clock
 * time — response equality alone does not close the timing channel.
 */
export const TIMING_DECOY_PASSWORD_HASH =
  '$2b$10$wpkcyS1/EsD.o3.//9iUteV3UfCBjJXtkrNX4jiH.5.xdHNzhMFqq';

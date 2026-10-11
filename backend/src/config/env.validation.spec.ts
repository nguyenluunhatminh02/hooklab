import { validateEnv } from './env.validation';

const DATABASE_URL = 'postgresql://hooklab:hooklab@localhost:5435/hooklab';
const JWT_SECRET = 'a'.repeat(32);
const PUBLIC_BASE_URL = 'http://localhost:3000';

const VALID_ENV = { DATABASE_URL, JWT_SECRET, PUBLIC_BASE_URL };

function envWith(overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  return { ...VALID_ENV, ...overrides };
}

// validateEnv is a pure function over the passed object (nothing reads process.env at
// import time), so every case calls it directly with a plain env literal.
function rejectionMessage(env: NodeJS.ProcessEnv): string {
  try {
    validateEnv(env);
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error('validateEnv accepted an env that must be rejected');
}

describe('validateEnv', () => {
  it('returns a fully valid env with PORT coerced to a number', () => {
    const result = validateEnv(envWith());

    expect(result).toEqual({
      DATABASE_URL,
      JWT_SECRET,
      PUBLIC_BASE_URL,
      PORT: 3000,
    });
    expect(typeof result.PORT).toBe('number');
  });

  it('accepts the postgres:// alias and an https base URL', () => {
    const result = validateEnv(
      envWith({
        DATABASE_URL: 'postgres://hooklab:hooklab@localhost:5435/hooklab',
        PUBLIC_BASE_URL: 'https://hooklab.example.com',
      }),
    );

    expect(result.DATABASE_URL).toBe('postgres://hooklab:hooklab@localhost:5435/hooklab');
    expect(result.PUBLIC_BASE_URL).toBe('https://hooklab.example.com');
  });

  describe('DATABASE_URL', () => {
    it('rejects a non-postgres scheme', () => {
      expect(() =>
        validateEnv(envWith({ DATABASE_URL: 'mysql://hooklab:hooklab@localhost:3306/hooklab' })),
      ).toThrow(/DATABASE_URL must be a postgresql:\/\/ connection string/);
    });

    it('rejects a value that is not a URI at all', () => {
      expect(() => validateEnv(envWith({ DATABASE_URL: 'not a connection string' }))).toThrow(
        /DATABASE_URL must be a postgresql/,
      );
    });

    it('rejects an empty value', () => {
      expect(() => validateEnv(envWith({ DATABASE_URL: '' }))).toThrow(
        /"DATABASE_URL" is not allowed to be empty/,
      );
    });
  });

  describe('JWT_SECRET', () => {
    it('rejects a missing key', () => {
      // Mirrors process.env on a machine where the variable was never exported.
      expect(() => validateEnv({ DATABASE_URL, PUBLIC_BASE_URL })).toThrow(
        /JWT_SECRET is required/,
      );
    });

    it('rejects a value shorter than 32 chars', () => {
      expect(() => validateEnv(envWith({ JWT_SECRET: 'a'.repeat(31) }))).toThrow(
        /JWT_SECRET must be at least 32 chars/,
      );
    });

    it('rejects an empty value (the blank .env.example line)', () => {
      expect(() => validateEnv(envWith({ JWT_SECRET: '' }))).toThrow(
        /"JWT_SECRET" is not allowed to be empty/,
      );
    });

    it('accepts exactly 32 chars', () => {
      expect(validateEnv(envWith({ JWT_SECRET: 'b'.repeat(32) })).JWT_SECRET).toHaveLength(32);
    });
  });

  describe('PUBLIC_BASE_URL', () => {
    it('rejects a missing key', () => {
      expect(() => validateEnv({ DATABASE_URL, JWT_SECRET })).toThrow(
        /"PUBLIC_BASE_URL" is required/,
      );
    });

    it('rejects a non-http(s) scheme', () => {
      expect(() => validateEnv(envWith({ PUBLIC_BASE_URL: 'ftp://hooklab.example.com' }))).toThrow(
        /scheme matching the http\|https pattern/,
      );
    });

    it('rejects a bare host without a scheme', () => {
      expect(() => validateEnv(envWith({ PUBLIC_BASE_URL: 'hooklab.example.com' }))).toThrow(
        /"PUBLIC_BASE_URL" must be a valid uri/,
      );
    });
  });

  describe('PORT', () => {
    it('defaults to 3000 when absent', () => {
      expect(validateEnv(envWith()).PORT).toBe(3000);
    });

    it('coerces a numeric string to a number', () => {
      const result = validateEnv(envWith({ PORT: '8080' }));

      expect(result.PORT).toBe(8080);
      expect(typeof result.PORT).toBe('number');
    });

    it('rejects a non-numeric value', () => {
      expect(() => validateEnv(envWith({ PORT: 'not-a-port' }))).toThrow(/"PORT" must be a number/);
    });

    it('rejects a port outside the valid range', () => {
      expect(() => validateEnv(envWith({ PORT: '70000' }))).toThrow(/"PORT" must be a valid port/);
    });
  });

  it('allows unknown keys and keeps them on the result', () => {
    const result = validateEnv(
      envWith({ POSTGRES_HOST_PORT: '5435', PATH: '/usr/local/bin' }),
    );

    expect(result).toMatchObject({ POSTGRES_HOST_PORT: '5435', PATH: '/usr/local/bin' });
  });

  it('reports every violation in one error (abortEarly is off)', () => {
    const message = rejectionMessage({
      DATABASE_URL: 'mysql://hooklab:hooklab@localhost:3306/hooklab',
      JWT_SECRET: 'too-short',
      PUBLIC_BASE_URL: 'ftp://hooklab.example.com',
      PORT: 'not-a-port',
    });

    expect(message).toMatch(/^Invalid environment:/);
    expect(message).toContain('DATABASE_URL must be a postgresql:// connection string');
    expect(message).toContain('JWT_SECRET must be at least 32 chars');
    expect(message).toContain('"PUBLIC_BASE_URL" must be a valid uri');
    expect(message).toContain('"PORT" must be a number');
    // Header line + one indented line per violation: all four arrived together.
    expect(message.split('\n  ')).toHaveLength(5);
  });
});

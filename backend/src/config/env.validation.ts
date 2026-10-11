import * as Joi from 'joi';

export interface AppEnv {
  DATABASE_URL: string;
  JWT_SECRET: string;
  PUBLIC_BASE_URL: string;
  PORT: number;
}

/**
 * Fail-fast env validation at bootstrap (conventions §3/§6).
 * Called from main.ts before NestFactory.create — a bad env never boots.
 */
export function validateEnv(env: NodeJS.ProcessEnv): AppEnv {
  const schema = Joi.object<AppEnv>({
    DATABASE_URL: Joi.string()
      .uri({ scheme: ['postgresql', 'postgres'] })
      .required()
      .messages({
        'string.uriCustomScheme':
          'DATABASE_URL must be a postgresql:// connection string',
      }),
    JWT_SECRET: Joi.string().min(32).required().messages({
      'string.min': 'JWT_SECRET must be at least 32 chars (openssl rand -hex 32)',
      'any.required': 'JWT_SECRET is required (openssl rand -hex 32)',
    }),
    PUBLIC_BASE_URL: Joi.string().uri({ scheme: ['http', 'https'] }).required(),
    PORT: Joi.number().port().default(3000),
  });

  const { error, value } = schema.validate(env, {
    abortEarly: false,
    allowUnknown: true,
  });
  if (error) {
    const details = error.details.map((d) => d.message).join('\n  ');
    throw new Error(`Invalid environment:\n  ${details}`);
  }
  return value;
}

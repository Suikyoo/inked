// JSON-schema fragments shared by the route definitions (validated by Fastify's Ajv).

export const UUID_RE = '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$';

export const ENC_META_MAX = 8 * 1024;
export const ENC_BODY_MAX = 2 * 1024 * 1024;
export const BODY_LIMIT = 4 * 1024 * 1024;

export const uuid = { type: 'string', pattern: UUID_RE } as const;
export const nullableUuid = { type: ['string', 'null'], pattern: UUID_RE } as const;

/** `"v1." + base64url(iv[12] || ciphertext || tag[16])` — at least 28 bytes, so >= 38 chars. */
const ciphertext = (maxLength: number) =>
  ({ type: 'string', maxLength, pattern: '^v1\\.[A-Za-z0-9_-]{38,}$' }) as const;

export const encMeta = ciphertext(ENC_META_MAX);
export const encBody = ciphertext(ENC_BODY_MAX);
export const wrappedKey = ciphertext(1024);

/** base64url of 32 bytes (authKey, recoveryAuth); trailing padding tolerated. */
export const key32 = { type: 'string', pattern: '^[A-Za-z0-9_-]{43}=?$' } as const;

/** base64url of 16 bytes; trailing padding tolerated. */
export const kdfSalt = { type: 'string', pattern: '^[A-Za-z0-9_-]{22}(==)?$' } as const;

/** Accepts mixed case; handlers lowercase before use. */
export const username = { type: 'string', minLength: 3, maxLength: 32, pattern: '^[A-Za-z0-9_.-]+$' } as const;

export const kdfParams = {
  type: 'object',
  additionalProperties: false,
  required: ['alg', 'm', 't', 'p'],
  properties: {
    alg: { type: 'string', const: 'argon2id' },
    m: { type: 'integer', minimum: 65536, maximum: 1048576 },
    t: { type: 'integer', minimum: 3, maximum: 16 },
    p: { type: 'integer', minimum: 1, maximum: 8 },
  },
} as const;

export const idParams = {
  type: 'object',
  required: ['id'],
  properties: { id: uuid },
} as const;

export interface KdfParams {
  alg: 'argon2id';
  m: number;
  t: number;
  p: number;
}

export const DEFAULT_KDF_PARAMS: KdfParams = { alg: 'argon2id', m: 65536, t: 3, p: 1 };

/** Fixed key order so stored and fake params serialize identically. */
export const normalizeKdfParams = (p: KdfParams): KdfParams => ({ alg: p.alg, m: p.m, t: p.t, p: p.p });

import { randomBytes, scrypt, timingSafeEqual, type ScryptOptions } from 'node:crypto'
import { z } from 'zod'
import type { StoredCredential } from './store'

export const pinSchema = z.string().regex(/^\d{4,8}$/, 'PIN must be 4 to 8 digits')
export const passwordSchema = z.string().min(8, 'Password must be at least 8 characters').max(1024)

export interface ScryptParams {
  readonly keyLength: number
  readonly cost: number
  readonly blockSize: number
  readonly parallelization: number
}

/**
 * N = 2^17, r = 8, p = 1 (128 MiB, a few hundred ms). Older credentials hashed with lower costs keep
 * verifying because every stored credential carries its own parameters.
 */
export const DEFAULT_SCRYPT_PARAMS: ScryptParams = {
  keyLength: 64,
  cost: 131072,
  blockSize: 8,
  parallelization: 1
}

const SALT_BYTES = 16

const isPow2 = (n: number): boolean => Number.isInteger(n) && n >= 2 && (n & (n - 1)) === 0

/** Guards against corrupt/hostile stored parameters (memory or CPU exhaustion). */
export function assertSafeParams(p: ScryptParams): void {
  const ok =
    isPow2(p.cost) &&
    p.cost <= 1 << 20 &&
    Number.isInteger(p.blockSize) && p.blockSize >= 1 && p.blockSize <= 32 &&
    Number.isInteger(p.parallelization) && p.parallelization >= 1 && p.parallelization <= 16 &&
    Number.isInteger(p.keyLength) && p.keyLength >= 16 && p.keyLength <= 128
  if (!ok) throw new Error('AUTH_BAD_SCRYPT_PARAMS')
}

function derive(secret: string, salt: Buffer, p: ScryptParams): Promise<Buffer> {
  assertSafeParams(p)
  const options: ScryptOptions = {
    cost: p.cost,
    blockSize: p.blockSize,
    parallelization: p.parallelization,
    // Node needs maxmem > 128 * N * r (* p to be safe); add headroom.
    maxmem: 128 * p.cost * p.blockSize * p.parallelization + 16 * 1024 * 1024
  }
  return new Promise((resolve, reject) => {
    scrypt(secret.normalize('NFKC'), salt, p.keyLength, options, (err, key) =>
      err ? reject(err) : resolve(key)
    )
  })
}

export async function hashCredential(
  secret: string,
  params: ScryptParams = DEFAULT_SCRYPT_PARAMS
): Promise<StoredCredential> {
  const salt = randomBytes(SALT_BYTES)
  const hash = await derive(secret, salt, params)
  return {
    algorithm: 'scrypt',
    salt: salt.toString('base64'),
    hash: hash.toString('base64'),
    ...params
  }
}

/** Constant-time verification using the parameters stored with the credential. */
export async function verifyCredential(
  secret: string,
  stored: StoredCredential
): Promise<boolean> {
  const expected = Buffer.from(stored.hash, 'base64')
  const actual = await derive(secret, Buffer.from(stored.salt, 'base64'), stored)
  return actual.length === expected.length && timingSafeEqual(actual, expected)
}

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/**
 * AES-256-GCM for integration secrets at rest (BUILD_PLAN §12.3): the
 * JoFotara Secret-Key is stored only in this sealed form. The key comes from
 * EINVOICE_ENC_KEY (32 bytes, base64). Format: `v1.<iv>.<tag>.<ciphertext>`
 * (base64url parts); a wrong key or any change to the text fails to open.
 */
const VERSION = 'v1';

/** Whether `base64Key` can seal and open secrets (checked at boot in production). */
export function isSealingKey(base64Key: string | undefined): boolean {
  try {
    keyFrom(base64Key);
    return true;
  } catch {
    return false;
  }
}

/** A 32-byte key from its base64 form; `name` is the variable named in the error. Shared with the backup key. */
export function parseKey32(base64Key: string | undefined, name: string): Buffer {
  const key = base64Key ? Buffer.from(base64Key, 'base64') : Buffer.alloc(0);
  if (key.length !== 32) {
    throw new Error(`${name} must be 32 random bytes, base64-encoded`);
  }
  return key;
}

function keyFrom(base64Key: string | undefined): Buffer {
  return parseKey32(base64Key, 'EINVOICE_ENC_KEY');
}

export function sealSecret(plain: string, base64Key: string | undefined): string {
  const key = keyFrom(base64Key);
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [VERSION, iv.toString('base64url'), tag.toString('base64url'), data.toString('base64url')].join('.');
}

export function openSecret(sealed: string, base64Key: string | undefined): string {
  const key = keyFrom(base64Key);
  const [version, iv, tag, data] = sealed.split('.');
  if (version !== VERSION || !iv || !tag || data === undefined) {
    throw new Error('Not a sealed secret');
  }
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'));
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(data, 'base64url')), decipher.final()]).toString('utf8');
}

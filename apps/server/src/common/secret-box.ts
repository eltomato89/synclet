import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';

/**
 * AES-256-GCM sealing of small secrets at rest. The key is HKDF-SHA256(secret, info = purpose), so a
 * ciphertext made for one purpose never opens under another. `aad` (default: the purpose) is bound
 * as additional authenticated data, e.g. a row id, so a ciphertext cannot be moved to another row.
 * Format: base64url `iv.ciphertext.tag`.
 */
export class SecretBox {
  private readonly keys = new Map<string, Buffer>();

  constructor(private readonly secret: string) {}

  private key(purpose: string): Buffer {
    let k = this.keys.get(purpose);
    if (!k) {
      k = Buffer.from(hkdfSync('sha256', Buffer.from(this.secret, 'utf8'), Buffer.alloc(0), purpose, 32));
      this.keys.set(purpose, k);
    }
    return k;
  }

  seal(plaintext: string, purpose: string, aad: string = purpose): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key(purpose), iv);
    cipher.setAAD(Buffer.from(aad, 'utf8'));
    const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    return [iv, ct, cipher.getAuthTag()].map((b) => b.toString('base64url')).join('.');
  }

  /** Throws on malformed input, wrong purpose/aad or a different secret. */
  open(sealed: string, purpose: string, aad: string = purpose): string {
    const [iv, ct, tag] = sealed.split('.').map((p) => Buffer.from(p, 'base64url'));
    if (!iv || !ct || !tag || iv.length !== 12 || tag.length !== 16) throw new Error('malformed sealed value');
    const decipher = createDecipheriv('aes-256-gcm', this.key(purpose), iv);
    decipher.setAAD(Buffer.from(aad, 'utf8'));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
  }
}

import { PassThrough, Readable, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { RateLimiter } from '../auth/rate-limit';
import { decryptToken, encryptToken, parseItemId, SHARE_TOKEN, shareTokenKey } from './share-auth';
import { createZip } from './zip';

const ID = '3f2b8c1e-1d2a-4c3b-9a8b-0123456789ab';
const OTHER = '11111111-1d2a-4c3b-9a8b-0123456789ab';
const silent = { warn: () => undefined };

describe('share token encryption (ruling 1b-3)', () => {
  const key = shareTokenKey('server-secret');
  const token = 'A'.repeat(43);

  it('round-trips with a random IV in base64url iv.ciphertext.tag form', () => {
    const a = encryptToken(key, token, ID);
    const b = encryptToken(key, token, ID);
    expect(a).not.toBe(b);
    expect(a).toMatch(/^[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{22}$/);
    expect(decryptToken(key, a, ID)).toBe(token);
  });

  it('rejects another share id, another secret and tampering', () => {
    const enc = encryptToken(key, token, ID);
    expect(() => decryptToken(key, enc, OTHER)).toThrow();
    expect(() => decryptToken(shareTokenKey('other-secret'), enc, ID)).toThrow();
    const [iv, ct, tag] = enc.split('.');
    const flipped = Buffer.from(ct, 'base64url');
    flipped[0] ^= 1;
    expect(() => decryptToken(key, [iv, flipped.toString('base64url'), tag].join('.'), ID)).toThrow();
    expect(() => decryptToken(key, 'garbage', ID)).toThrow();
  });

  it('derives a stable 32-byte key per secret', () => {
    expect(shareTokenKey('s')).toHaveLength(32);
    expect(shareTokenKey('s').equals(shareTokenKey('s'))).toBe(true);
    expect(shareTokenKey('s').equals(shareTokenKey('t'))).toBe(false);
  });
});

describe('share ids and tokens', () => {
  it('parses sync ids and bare uuids only', () => {
    expect(parseItemId(`d_${ID}`)).toBe(ID);
    expect(parseItemId(`f_${ID}`)).toBe(ID);
    expect(parseItemId(ID)).toBe(ID);
    for (const bad of ['root', '', undefined, '../x', `x_${ID}`, `${ID}/..`]) expect(parseItemId(bad)).toBeNull();
  });

  it('accepts only 43-char base64url tokens', () => {
    expect(SHARE_TOKEN.test('a'.repeat(43))).toBe(true);
    expect(SHARE_TOKEN.test('a'.repeat(42))).toBe(false);
    expect(SHARE_TOKEN.test(`${'a'.repeat(42)}/`)).toBe(false);
  });
});

describe('RateLimiter', () => {
  it('allows a burst, then refills over time; keys are independent; reset clears', () => {
    let now = 0;
    const rl = new RateLimiter({ capacity: 2, refillPerSec: 1 }, () => now);
    expect([rl.take('a'), rl.take('a'), rl.take('a')]).toEqual([true, true, false]);
    expect(rl.take('b')).toBe(true);
    now += 1000;
    expect(rl.take('a')).toBe(true);
    expect(rl.take('a')).toBe(false);
    rl.reset('a');
    expect(rl.take('a')).toBe(true);
  });

  it('evicts least recently used keys beyond maxKeys', () => {
    const rl = new RateLimiter({ capacity: 1, refillPerSec: 0, maxKeys: 2 }, () => 0);
    rl.take('a'); rl.take('b'); rl.take('c'); // 'a' evicted -> fresh bucket
    expect(rl.take('a')).toBe(true);
    expect(rl.take('c')).toBe(false);
  });
});

describe('createZip', () => {
  const collect = async (r: Readable) => {
    const chunks: Buffer[] = [];
    await pipeline(r, new Writable({ write(c: Buffer, _e, cb) { chunks.push(c); cb(); } }));
    return Buffer.concat(chunks);
  };

  it('opens files lazily one at a time and skips entries that cannot be opened', async () => {
    let open = 0; let maxOpen = 0;
    const file = (body: string) => async () => {
      open++; maxOpen = Math.max(maxOpen, open);
      const r = Readable.from([Buffer.from(body)]);
      r.on('close', () => { open--; });
      return r;
    };
    const zip = createZip([
      { name: 'd', type: 'folder', mtime: new Date() },
      { name: 'd/a.txt', type: 'file', mtime: new Date(), open: file('a') },
      { name: 'gone.txt', type: 'file', mtime: new Date(), open: async () => null },
      { name: 'broken.txt', type: 'file', mtime: new Date(), open: async () => { throw new Error('EACCES'); } },
      { name: 'b.txt', type: 'file', mtime: new Date(), open: file('b') },
    ], silent);
    const buf = await collect(zip.stream);
    expect(buf.subarray(0, 4).toString('hex')).toBe('504b0304');
    const text = buf.toString('latin1');
    expect(text).toContain('d/a.txt');
    expect(text).toContain('b.txt');
    expect(text).not.toContain('gone.txt');
    expect(text).not.toContain('broken.txt');
    expect(maxOpen).toBe(1);
  });

  it('abort destroys the file being read and opens nothing further', async () => {
    const slow = new PassThrough();
    slow.write(Buffer.alloc(1024));
    let opened = 0;
    const zip = createZip([
      { name: 'slow.bin', type: 'file', mtime: new Date(), open: async () => { opened++; return slow; } },
      { name: 'next.bin', type: 'file', mtime: new Date(), open: async () => { opened++; return Readable.from([Buffer.from('x')]); } },
    ], silent);
    zip.stream.resume();
    await new Promise((r) => setTimeout(r, 50));
    zip.abort();
    await new Promise((r) => setTimeout(r, 50));
    expect(slow.destroyed).toBe(true);
    expect(opened).toBe(1);
    zip.abort(); // idempotent
  });
});

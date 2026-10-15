import { SecretBox } from './secret-box';

describe('SecretBox', () => {
  const box = new SecretBox('server-secret');

  it('round-trips and is randomized', () => {
    const a = box.seal('hello', 'p');
    expect(a).not.toBe(box.seal('hello', 'p'));
    expect(box.open(a, 'p')).toBe('hello');
  });

  it('rejects other purpose, aad, secret, tampering and garbage', () => {
    const a = box.seal('hello', 'p');
    expect(() => box.open(a, 'q')).toThrow();
    expect(() => new SecretBox('other').open(a, 'p')).toThrow();
    const b = box.seal('hello', 'p', 'row-1');
    expect(box.open(b, 'p', 'row-1')).toBe('hello');
    expect(() => box.open(b, 'p', 'row-2')).toThrow();
    const [iv, ct, tag] = a.split('.');
    const flipped = Buffer.from(ct, 'base64url');
    flipped[0] ^= 1;
    expect(() => box.open([iv, flipped.toString('base64url'), tag].join('.'), 'p')).toThrow();
    expect(() => box.open('garbage', 'p')).toThrow();
  });

  it('opens share tokens sealed by the pre-extraction implementation', () => {
    // Made with the old encryptToken(shareTokenKey('server-secret'), 'tok-legacy-123', shareId).
    const legacy = 'xHi-d3B-McVxUFOQ.yZMsu4n7PeS4zlw9eJs.7dMe9hf1LgywKN0xjvTSWg';
    expect(box.open(legacy, 'synclet-share-v1', '11111111-1111-4111-8111-111111111111')).toBe('tok-legacy-123');
  });
});

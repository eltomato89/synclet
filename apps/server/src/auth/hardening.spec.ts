import { chmod, mkdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { createTestApp, TestContext } from '../../test/context';
import { RateLimiter } from './rate-limit';

describe('RateLimiter', () => {
  it('allows a burst, refills over time and resets per key', () => {
    let now = 0;
    const rl = new RateLimiter({ capacity: 2, refillPerSec: 1 }, () => now);
    expect([rl.take('a'), rl.take('a'), rl.take('a')]).toEqual([true, true, false]);
    expect(rl.take('b')).toBe(true);
    expect(rl.retryAfterSec('a')).toBe(1);
    now = 1000;
    expect(rl.take('a')).toBe(true);
    expect(rl.take('a')).toBe(false);
    rl.reset('a');
    expect(rl.take('a')).toBe(true);
  });

  it('bounds the number of tracked keys (LRU)', () => {
    const rl = new RateLimiter({ capacity: 1, refillPerSec: 0.001, maxKeys: 2 });
    rl.take('a'); rl.take('b'); rl.take('c'); // 'a' evicted
    expect(rl.take('a')).toBe(true);
    expect(rl.take('c')).toBe(false);
  });
});

describe('auth hardening', () => {
  let ctx: TestContext;
  let ipSeq = 0;
  beforeEach(async () => { ctx = await createTestApp(); });
  afterEach(async () => { await ctx.close(); });

  const freshIp = () => `10.9.${Math.floor(ipSeq / 250)}.${(ipSeq++ % 250) + 1}`;
  const setup = (body: object = {}, remoteAddress = freshIp()) =>
    ctx.app.inject({ method: 'POST', url: '/api/setup', remoteAddress, payload: { username: 'jens', displayName: 'Jens', password: 'correct horse battery', ...body } });
  const login = (l: string, remoteAddress = freshIp(), password = 'wrong password') =>
    ctx.app.inject({ method: 'POST', url: '/api/auth/login', remoteAddress, payload: { login: l, password } });

  it('rate-limits login per IP with 429 + Retry-After', async () => {
    const ip = freshIp();
    for (let i = 0; i < 5; i++) expect((await login(`user${i}`, ip)).statusCode).toBe(401);
    const res = await login('user9', ip);
    expect(res.statusCode).toBe(429);
    expect(res.json().code).toBe('rate_limited');
    expect(Number(res.headers['retry-after'])).toBeGreaterThan(0);
    expect((await login('user9')).statusCode).toBe(401); // other IP unaffected
  });

  it('rate-limits login per normalized login name across IPs', async () => {
    await setup();
    for (let i = 0; i < 10; i++) expect((await login(' JENS ')).statusCode).toBe(401);
    const res = await login('jens');
    expect(res.statusCode).toBe(429);
    expect(res.headers['retry-after']).toBeDefined();
  });

  it('a successful login resets the per-login bucket', async () => {
    await setup();
    for (let i = 0; i < 9; i++) await login('jens');
    expect((await login('jens', freshIp(), 'correct horse battery')).statusCode).toBe(200);
    for (let i = 0; i < 9; i++) expect((await login('jens')).statusCode).toBe(401);
  });

  it('rate-limits POST /api/setup per IP', async () => {
    const ip = freshIp();
    for (let i = 0; i < 5; i++) expect((await setup({ username: '../x' }, ip)).statusCode).toBe(400);
    expect((await setup({ username: '../x' }, ip)).statusCode).toBe(429);
  });

  it('rejects bidi controls, zero-width characters and @ in usernames', async () => {
    for (const username of ['a‮b', 'a‏b', 'a‎b', 'a⁦b', 'a⁩b', 'a​b', 'a‍b', 'a⁠b', 'a﻿b', 'a@b', 'a‪b']) {
      expect([username, (await setup({ username })).statusCode]).toEqual([username, 400]);
    }
    expect((await setup()).statusCode).toBe(201);
  });

  const isRoot = () => process.getuid?.() === 0;

  it('unwritable data root: 500 data folder not writable, no user, retry works', async () => {
    await chmod(ctx.config.dataRoot, 0o500);
    try {
      if (!isRoot()) {
        const res = await setup();
        expect(res.statusCode).toBe(500);
        expect(res.json()).toMatchObject({ code: 'invalid_request' });
        expect(res.json().message).toContain('data folder not writable');
        expect(await ctx.prisma.user.count()).toBe(0);
      }
    } finally {
      await chmod(ctx.config.dataRoot, 0o700);
    }
    expect((await setup()).statusCode).toBe(201);
    expect((await stat(path.join(ctx.config.dataRoot, 'jens'))).isDirectory()).toBe(true);
  });

  it('unwritable existing user folder: 500 and no user', async () => {
    const dir = path.join(ctx.config.dataRoot, 'jens');
    await mkdir(dir);
    await chmod(dir, 0o500);
    try {
      if (!isRoot()) {
        expect((await setup()).statusCode).toBe(500);
        expect(await ctx.prisma.user.count()).toBe(0);
      }
    } finally {
      await chmod(dir, 0o700);
    }
  });
});

import { DirDebouncer } from './debounce';

beforeEach(() => { jest.useFakeTimers(); });
afterEach(() => { jest.useRealTimers(); });

it('coalesces bursts per key and upgrades to recursive', async () => {
  const calls: [string, boolean][] = [];
  const d = new DirDebouncer(async (k, r) => { calls.push([k, r]); }, 2000, 10000);
  d.push('u1\u0000a', false);
  await jest.advanceTimersByTimeAsync(1500);
  d.push('u1\u0000a', true);
  await jest.advanceTimersByTimeAsync(1500);
  expect(calls).toEqual([]);
  await jest.advanceTimersByTimeAsync(600);
  await d.flushAll(); // drains the serialized run chain
  expect(calls).toEqual([['u1\u0000a', true]]);
  d.stop();
});

it('fires at maxMs even under constant events', async () => {
  const calls: { key: string; at: number }[] = [];
  const start = Date.now();
  const d = new DirDebouncer(async (key) => { calls.push({ key, at: Date.now() - start }); }, 2000, 5000);
  for (let t = 0; t < 6000; t += 1000) { d.push('k', false); await jest.advanceTimersByTimeAsync(1000); }
  expect(calls).toEqual([{ key: 'k', at: 5000 }]);
  d.stop();
});

it('runs different keys serially and survives a failing run', async () => {
  const order: string[] = [];
  const d = new DirDebouncer(async (k) => {
    order.push(`start ${k}`);
    await new Promise((r) => setTimeout(r, 100));
    order.push(`end ${k}`);
    if (k === 'a') throw new Error('boom');
  }, 10, 100);
  d.push('a', false);
  d.push('b', false);
  await jest.advanceTimersByTimeAsync(10);
  await jest.advanceTimersByTimeAsync(300);
  expect(order).toEqual(['start a', 'end a', 'start b', 'end b']);
  d.stop();
});

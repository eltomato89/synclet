// The sample stack for the App Store screenshots of the iOS app (scripts/ios-store-screenshots.sh):
// the website's throwaway stack and sample data, plus an iOS device token for the DEBUG sign-in.
// Writes {"base", "token"} to the file given as the first argument once everything is ready and
// keeps the stack running until it gets SIGINT/SIGTERM (then it removes it again).
//
//   node scripts/store-stack.ts <ready.json>
import { writeFileSync } from 'node:fs';
import { ADMIN, json, seed, startSampleStack } from './sample-stack.ts';
import { request } from 'playwright';

const out = process.argv[2];
if (!out) throw new Error('usage: node scripts/store-stack.ts <ready.json>');
const PORT = Number(process.env.STORE_SHOTS_PORT ?? 18191);

const base = await startSampleStack('store-shots', PORT);
await seed(base, { extraPhotos: 12 });
const anon = await request.newContext({ baseURL: base });
const login = await json<{ accessToken: string }>(await anon.post('/api/auth/login', { data: { login: ADMIN.username, password: ADMIN.password } }), 'login');
const device = await json<{ token: string }>(await anon.post('/api/sync/v1/devices', {
  headers: { authorization: `Bearer ${login.accessToken}` },
  data: { name: 'iPhone', platform: 'ios', appVersion: 'screenshots' },
}), 'device token');
await anon.dispose();
writeFileSync(out, JSON.stringify({ base, token: device.token }));
console.log('== ready:', base);
setInterval(() => {}, 1 << 30); // until SIGINT/SIGTERM (sample-stack.ts cleans up)

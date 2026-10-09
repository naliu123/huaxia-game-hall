import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { JsonStore, MemoryRateLimiter, createApp, signJwt, verifyJwt } from '../src/server/index.js';

test('JWT 可签发并校验会话', () => {
  const token = signJwt({ sub: 'user-1', phone: '13800000000' }, 'test-secret', 60);
  const payload = verifyJwt(token, 'test-secret');
  assert.equal(payload.sub, 'user-1');
  assert.equal(payload.phone, '13800000000');
});

test('JWT 拒绝被篡改的签名', () => {
  const token = signJwt({ sub: 'user-1' }, 'test-secret', 60);
  assert.equal(verifyJwt(`${token}x`, 'test-secret'), null);
  assert.equal(verifyJwt(token, 'another-secret'), null);
});

test('JWT 拒绝过期会话', () => {
  const token = signJwt({ sub: 'user-1' }, 'test-secret', -1);
  assert.equal(verifyJwt(token, 'test-secret'), null);
});

test('限流器按时间窗限制请求并自动恢复', () => {
  const limiter = new MemoryRateLimiter(2, 1000);
  assert.equal(limiter.consume('client', 0), true);
  assert.equal(limiter.consume('client', 100), true);
  assert.equal(limiter.consume('client', 200), false);
  assert.equal(limiter.consume('client', 1200), true);
});

test('手机号可注册、退出并使用验证码再次登录', async t => {
  const file = path.join(tmpdir(), `game-auth-${process.pid}-${Date.now()}.json`);
  await rm(file, { force: true });
  const instance = createApp({ requireAuth: true, app: 'gobang', dataStore: new JsonStore(file) });
  instance.server.listen(0, '127.0.0.1');
  await once(instance.server, 'listening');
  const origin = `http://127.0.0.1:${instance.server.address().port}`;
  t.after(async () => {
    instance.realtime.stop();
    for (const client of instance.wss.clients) client.terminate();
    await new Promise(resolve => instance.server.close(resolve));
    await rm(file, { force: true });
  });

  const send = await fetch(`${origin}/api/auth/sms/send`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ phone: '13800000001' })
  });
  const { developmentCode } = await send.json();
  assert.match(developmentCode, /^\d{6}$/);

  const register = await fetch(`${origin}/api/auth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ phone: '13800000001', password: 'password123', code: developmentCode })
  });
  assert.equal(register.status, 201);
  assert.match(register.headers.get('set-cookie'), /HttpOnly/);

  const resend = await fetch(`${origin}/api/auth/sms/send`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ phone: '13800000001' })
  });
  const nextCode = (await resend.json()).developmentCode;
  const login = await fetch(`${origin}/api/auth/sms/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ phone: '13800000001', code: nextCode })
  });
  assert.equal(login.status, 200);
  assert.equal((await login.json()).user.phone, '13800000001');
});

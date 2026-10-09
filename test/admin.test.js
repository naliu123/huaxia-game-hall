import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { JsonStore, createApp, signJwt } from '../src/server/index.js';

async function setup(t, app = 'admin') {
  const file = path.join(tmpdir(), `game-admin-${process.pid}-${Date.now()}.json`);
  const store = new JsonStore(file);
  await store.update(data => {
    data.users.push({ id: 'user-1', phone: '13800000000', nickname: '测试玩家', createdAt: '2026-09-01T00:00:00.000Z' });
    data.matches.push({ id: 'match-1', userId: 'user-1', game: 'gobang', result: 'win', createdAt: '2026-09-19T00:00:00.000Z' });
  });
  const instance = createApp({ requireAuth: true, app, dataStore: store });
  instance.server.listen(0, '127.0.0.1');
  await once(instance.server, 'listening');
  t.after(async () => {
    instance.realtime.stop();
    for (const client of instance.wss.clients) client.terminate();
    await new Promise(resolve => instance.server.close(resolve));
    await rm(file, { force: true });
  });
  return { origin: `http://127.0.0.1:${instance.server.address().port}`, store };
}

test('管理员独立认证后可查看看板、配置游戏并写入审计日志', async t => {
  process.env.ADMIN_PASSWORD = 'admin-test-password';
  t.after(() => delete process.env.ADMIN_PASSWORD);
  const { origin } = await setup(t);
  const login = await fetch(`${origin}/api/admin/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'admin-test-password' }),
  });
  assert.equal(login.status, 200);
  assert.match(login.headers.get('set-cookie'), /HttpOnly/);
  assert.match(login.headers.get('set-cookie'), /SameSite=Strict/);
  const cookie = login.headers.get('set-cookie').split(';')[0];

  const dashboard = await fetch(`${origin}/api/admin/dashboard`, { headers: { cookie } });
  assert.equal(dashboard.status, 200);
  assert.equal((await dashboard.json()).stats.users, 1);

  const update = await fetch(`${origin}/api/admin/settings`, {
    method: 'PATCH',
    headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ announcement: '今晚维护', games: { gobang: { enabled: false, maintenance: '升级中' } } }),
  });
  assert.equal(update.status, 200);
  const publicConfig = await (await fetch(`${origin}/api/config`)).json();
  assert.equal(publicConfig.settings.games.gobang.enabled, false);
  assert.equal(publicConfig.settings.announcement, '今晚维护');
  const logs = await (await fetch(`${origin}/api/admin/audit-logs`, { headers: { cookie } })).json();
  assert.ok(logs.logs.some(item => item.action === 'settings.update'));
});

test('管理员禁用用户后，已有玩家会话也立即失效', async t => {
  process.env.ADMIN_PASSWORD = 'admin-test-password';
  t.after(() => delete process.env.ADMIN_PASSWORD);
  const { origin } = await setup(t);
  const login = await fetch(`${origin}/api/admin/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'admin-test-password' }),
  });
  const adminCookie = login.headers.get('set-cookie').split(';')[0];
  const disabled = await fetch(`${origin}/api/admin/users/user-1`, {
    method: 'PATCH',
    headers: { cookie: adminCookie, 'content-type': 'application/json' },
    body: JSON.stringify({ disabled: true }),
  });
  assert.equal(disabled.status, 200);

  const playerToken = signJwt({ sub: 'user-1', phone: '13800000000' });
  const me = await fetch(`${origin}/api/me`, { headers: { cookie: `session=${playerToken}` } });
  assert.equal(me.status, 403);
  assert.match((await me.json()).error, /禁用/);
});

test('公开游戏应用不暴露管理员接口', async t => {
  const { origin } = await setup(t, 'gobang');
  const response = await fetch(`${origin}/api/admin/dashboard`);
  assert.equal(response.status, 404);
});

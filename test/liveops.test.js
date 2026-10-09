import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { JsonStore, createApp } from '../src/server/index.js';

async function request(origin, route, cookie, method = 'GET', payload, headers = {}) {
  return fetch(`${origin}${route}`, {
    method,
    headers: { ...(cookie && { cookie }), ...(payload && { 'content-type': 'application/json' }), ...headers },
    ...(payload && { body: JSON.stringify(payload) }),
  });
}

test('LiveOps 支持 RBAC、配置发布确认、画像导出与全量审计', async t => {
  const file = path.join(tmpdir(), `liveops-${process.pid}-${Date.now()}.json`);
  process.env.ADMIN_PASSWORD = 'root-test-password';
  const store = new JsonStore(file);
  await store.update(data => {
    data.users.push({ id: 'player-1', phone: '13800000009', nickname: '画像玩家', createdAt: '2026-09-01T00:00:00.000Z' });
    data.matches.push({ id: 'match-profile', userId: 'player-1', game: 'gobang', result: 'win', createdAt: '2026-09-02T00:00:00.000Z' });
  });
  const instance = createApp({ requireAuth: true, app: 'admin', dataStore: store });
  instance.server.listen(0, '127.0.0.1');
  await once(instance.server, 'listening');
  const origin = `http://127.0.0.1:${instance.server.address().port}`;
  t.after(async () => {
    delete process.env.ADMIN_PASSWORD;
    instance.realtime.stop();
    await new Promise(resolve => instance.server.close(resolve));
    await rm(file, { force: true });
  });

  const login = await request(origin, '/api/admin/auth/login', '', 'POST', { username: 'admin', password: 'root-test-password' });
  assert.equal(login.status, 200);
  const rootCookie = login.headers.get('set-cookie').split(';')[0];

  const bootstrap = await request(origin, '/api/admin/liveops/bootstrap', rootCookie);
  assert.equal(bootstrap.status, 200);
  assert.equal((await bootstrap.json()).adapters.payment.status, 'unconfigured');

  const staff = await request(origin, '/api/admin/liveops/staff', rootCookie, 'POST', {
    username: 'analyst-a', password: 'long-password', role: 'analyst',
  });
  assert.equal(staff.status, 201);
  const staffItem = (await staff.json()).item;
  assert.equal(staffItem.passwordHash, undefined);

  const version = await request(origin, '/api/admin/liveops/configVersions', rootCookie, 'POST', {
    name: '大厅参数', version: 'v1', payload: { matchmaking: true },
  });
  const versionId = (await version.json()).item.id;
  const rejected = await request(origin, `/api/admin/liveops/configVersions/${versionId}/publish`, rootCookie, 'POST', {});
  assert.equal(rejected.status, 428);
  assert.equal((await rejected.json()).code, 'CONFIRMATION_REQUIRED');
  const published = await request(origin, `/api/admin/liveops/configVersions/${versionId}/publish`, rootCookie, 'POST', {}, { 'x-confirm-action': 'config.publish' });
  assert.equal(published.status, 200);
  assert.equal((await published.json()).item.status, 'published');
  const publicConfig = await (await fetch(`${origin}/api/config`)).json();
  assert.equal(publicConfig.remoteConfig.matchmaking, true);

  const profile = await request(origin, '/api/admin/liveops/players/player-1', rootCookie);
  assert.equal(profile.status, 200);
  assert.equal((await profile.json()).profile.summary.wins, 1);
  const exported = await request(origin, '/api/admin/liveops/export/users?format=csv', rootCookie);
  assert.equal(exported.status, 200);
  assert.match(exported.headers.get('content-type'), /text\/csv/);
  assert.match(await exported.text(), /画像玩家/);

  const analystLogin = await request(origin, '/api/admin/auth/login', '', 'POST', { username: 'analyst-a', password: 'long-password' });
  assert.equal(analystLogin.status, 200);
  const analystCookie = analystLogin.headers.get('set-cookie').split(';')[0];
  const forbidden = await request(origin, '/api/admin/liveops/configVersions', analystCookie, 'POST', { name: '越权版本' });
  assert.equal(forbidden.status, 403);

  const ledgerPayload = { userId: 'player-1', asset: 'coin', delta: 100, reason: '测试补发', idempotencyKey: 'manual-test-1' };
  for (let index = 0; index < 2; index++) {
    const ledger = await request(origin, '/api/admin/liveops/inventoryLedger', rootCookie, 'POST', ledgerPayload, { 'x-confirm-action': 'inventory.adjust' });
    assert.equal(ledger.status, 201);
  }
  const ledgerRows = (await request(origin, '/api/admin/liveops/inventoryLedger', rootCookie).then(response => response.json())).rows;
  assert.equal(ledgerRows.filter(item => item.idempotencyKey === 'manual-test-1').length, 1);
  assert.equal(ledgerRows.find(item => item.idempotencyKey === 'manual-test-1').balanceAfter, 100);

  const disabledStaff = await request(origin, `/api/admin/liveops/staff/${staffItem.id}`, rootCookie, 'PATCH',
    { status: 'disabled' }, { 'x-confirm-action': 'staff.disable' });
  assert.equal(disabledStaff.status, 200);
  const staleSession = await request(origin, '/api/admin/auth/session', analystCookie);
  assert.equal(staleSession.status, 401);

  const persisted = await store.read();
  assert.ok(persisted.auditLogs.some(item => item.action === 'staff.create'));
  assert.ok(persisted.auditLogs.some(item => item.action === 'config.publish'));
});

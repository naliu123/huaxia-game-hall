import http from 'node:http';
import { createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { gomoku } from '../games/gomoku.js';
import { doudizhu } from '../games/doudizhu.js';
import { mahjong } from '../games/mahjong.js';
import { RoomManager } from '../room-manager.js';
import { RealtimeServer } from '../realtime-server.js';
import { can, ensureLiveOpsData, handleLiveOpsApi, permissionsFor } from './liveops.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const configuredApp = process.env.APP || 'gobang';
const config = {
  app: configuredApp,
  port: Number(process.env.PORT || (configuredApp === 'admin' ? 3100 : 3000)),
  jwtSecret: process.env.JWT_SECRET || 'development-only-change-me',
  dataFile: process.env.DATA_FILE || path.join(root, 'data', 'store.json'),
  wechatWebAppId: process.env.WECHAT_WEB_APP_ID || '',
  wechatWebSecret: process.env.WECHAT_WEB_SECRET || '',
  wechatMiniAppId: process.env.WECHAT_MINI_APP_ID || '',
  wechatMiniSecret: process.env.WECHAT_MINI_SECRET || '',
  publicOrigin: process.env.PUBLIC_ORIGIN || `http://localhost:${process.env.PORT || 3000}`,
  adminUsername: process.env.ADMIN_USERNAME || 'admin',
  adminPassword: process.env.ADMIN_PASSWORD || '',
  adminSecret: process.env.ADMIN_JWT_SECRET || process.env.JWT_SECRET || 'development-only-change-me',
};
const gameApps = new Set(['gobang', 'doudizhu', 'mahjong']);
const validApps = new Set([...gameApps, 'admin']);
if (!validApps.has(config.app)) throw new Error(`Unknown APP: ${config.app}`);
if (process.env.NODE_ENV === 'production' && config.jwtSecret.includes('development')) {
  throw new Error('JWT_SECRET must be configured in production');
}
if (config.app === 'admin' && process.env.NODE_ENV === 'production' && (!config.adminPassword || config.adminSecret.includes('development'))) {
  throw new Error('ADMIN_PASSWORD and ADMIN_JWT_SECRET must be configured in production');
}

const defaultSettings = () => ({
  games: {
    gobang: { enabled: true, maintenance: '' },
    doudizhu: { enabled: true, maintenance: '' },
    mahjong: { enabled: true, maintenance: '' },
  },
  announcement: '',
});

export class JsonStore {
  constructor(file) {
    this.file = file;
    this.pending = Promise.resolve();
  }
  async read() {
    try {
      const data = JSON.parse(await readFile(this.file, 'utf8'));
      return ensureLiveOpsData({ users: [], matches: [], smsCodes: [], auditLogs: [], onlineRooms: [], settings: defaultSettings(), ...data });
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      return ensureLiveOpsData({ users: [], matches: [], smsCodes: [], auditLogs: [], onlineRooms: [], settings: defaultSettings() });
    }
  }
  async update(mutator) {
    const operation = this.pending.then(async () => {
      const data = await this.read();
      const result = await mutator(data);
      await mkdir(path.dirname(this.file), { recursive: true });
      const temporary = `${this.file}.${process.pid}.tmp`;
      await writeFile(temporary, JSON.stringify(data, null, 2));
      await rename(temporary, this.file);
      return result;
    });
    this.pending = operation.catch(() => {});
    return operation;
  }
}

export class MemoryRateLimiter {
  constructor(limit = 8, windowMs = 60_000) {
    this.limit = limit;
    this.windowMs = windowMs;
    this.entries = new Map();
  }
  consume(key, now = Date.now()) {
    const recent = (this.entries.get(key) || []).filter((time) => now - time < this.windowMs);
    recent.push(now);
    this.entries.set(key, recent);
    return recent.length <= this.limit;
  }
}

export function signJwt(payload, secret = config.jwtSecret, expiresIn = 7 * 86400) {
  const header = encode({ alg: 'HS256', typ: 'JWT' });
  const body = encode({ ...payload, exp: Math.floor(Date.now() / 1000) + expiresIn });
  const signature = createHmac('sha256', secret).update(`${header}.${body}`).digest('base64url');
  return `${header}.${body}.${signature}`;
}

export function verifyJwt(token, secret = config.jwtSecret) {
  try {
    const [header, body, signature] = String(token || '').split('.');
    if (!header || !body || !signature) return null;
    const expected = createHmac('sha256', secret).update(`${header}.${body}`).digest();
    const actual = Buffer.from(signature, 'base64url');
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return null;
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString());
    return payload.exp > Date.now() / 1000 ? payload : null;
  } catch {
    return null;
  }
}

function encode(value) {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}
function hashPassword(password, salt = randomBytes(16).toString('hex')) {
  return `${salt}:${scryptSync(password, salt, 64).toString('hex')}`;
}
function passwordMatches(password, encoded) {
  const [salt, digest] = encoded.split(':');
  const actual = scryptSync(password, salt, 64);
  const expected = Buffer.from(digest, 'hex');
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}
function cookies(req) {
  return Object.fromEntries((req.headers.cookie || '').split(';').filter(Boolean).map((part) => {
    const [key, ...value] = part.trim().split('=');
    return [key, decodeURIComponent(value.join('='))];
  }));
}
function publicUser(user) {
  const { passwordHash, wechatId, ...safe } = user;
  return safe;
}
function json(res, status, value, headers = {}) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', ...headers });
  res.end(JSON.stringify(value));
}
async function body(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 64 * 1024) throw Object.assign(new Error('请求内容过大'), { status: 413 });
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString() || '{}');
  } catch {
    throw Object.assign(new Error('JSON 格式无效'), { status: 400 });
  }
}
function tokenFor(user) {
  return signJwt({ sub: user.id, phone: user.phone });
}
function sessionHeaders(token) {
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  return { 'set-cookie': `session=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=604800${secure}` };
}
function adminSessionHeaders(token, maxAge = 8 * 3600) {
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  return { 'set-cookie': `admin_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}${secure}` };
}
function userFrom(req, data) {
  const bearer = req.headers.authorization?.replace(/^Bearer /, '');
  const payload = verifyJwt(bearer || cookies(req).session);
  return payload ? data.users.find((item) => item.id === payload.sub) : null;
}
function adminFrom(req) {
  const payload = verifyJwt(cookies(req).admin_session, config.adminSecret);
  return payload?.kind === 'staff' || payload?.role === 'admin' ? payload : null;
}
function safeEqualText(actual, expected) {
  const a = Buffer.from(String(actual || ''));
  const b = Buffer.from(String(expected || ''));
  return a.length === b.length && timingSafeEqual(a, b);
}
function mergedSettings(data) {
  const defaults = defaultSettings();
  return {
    announcement: String(data.settings?.announcement || ''),
    games: Object.fromEntries([...gameApps].map((id) => [id, { ...defaults.games[id], ...(data.settings?.games?.[id] || {}) }])),
  };
}
function assertActive(user) {
  if (user?.disabled) throw Object.assign(new Error('账号已被禁用，请联系管理员'), { status: 403 });
}
function assertAdminPermission(admin, permission) {
  if (!can(admin, permission)) throw Object.assign(new Error(`缺少权限：${permission}`), { status: 403 });
}
function audit(data, admin, action, target, detail = '') {
  data.auditLogs ||= [];
  data.auditLogs.push({
    id: randomBytes(10).toString('hex'),
    admin,
    action,
    target,
    detail: String(detail).slice(0, 240),
    createdAt: new Date().toISOString(),
  });
  if (data.auditLogs.length > 2000) data.auditLogs.splice(0, data.auditLogs.length - 2000);
}
function roomSummary(room) {
  return {
    id: room.id,
    game: room.gameId === 'gomoku' ? 'gobang' : room.gameId,
    players: room.players.filter((item) => !item.expired).map(({ index, userId, nickname, connected, expiresAt }) => ({ index, userId, nickname, connected, expiresAt })),
    spectators: room.spectators.size,
    version: room.version,
    createdAt: new Date(room.createdAt).toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

function validSms(data, phone, code) {
  return data.smsCodes.find((item) => item.phone === phone && item.code === code && item.expiresAt > Date.now());
}

const store = new JsonStore(config.dataFile);
const authLimiter = new MemoryRateLimiter(10, 10 * 60_000);
const smsLimiter = new MemoryRateLimiter(4, 10 * 60_000);
const adminLimiter = new MemoryRateLimiter(5, 10 * 60_000);
const smsAdapter = {
  async send(phone, code) {
    console.log(`[dev-sms] ${phone}: ${code}`);
    return { delivered: true, ...(process.env.NODE_ENV !== 'production' && { developmentCode: code }) };
  },
};

async function adminApi(req, res, url, dataStore, rooms) {
  res.setHeader('cache-control', 'no-store');
  const ip = req.socket.remoteAddress || 'unknown';
  const origin = req.headers.origin;
  if (origin && ['POST', 'PATCH', 'DELETE'].includes(req.method) && origin !== config.publicOrigin) {
    return json(res, 403, { error: '请求来源无效' });
  }
  if (req.method === 'POST' && url.pathname === '/api/admin/auth/login') {
    if (!adminLimiter.consume(ip)) return json(res, 429, { error: '登录尝试过多，请稍后再试' });
    const input = await body(req);
    const current = await dataStore.read();
    const adminUsername = process.env.ADMIN_USERNAME || config.adminUsername;
    const adminPassword = process.env.ADMIN_PASSWORD || config.adminPassword;
    const rootLogin = adminPassword && safeEqualText(input.username, adminUsername) && safeEqualText(input.password, adminPassword);
    const staff = current.staff.find(item => item.username === input.username && item.status !== 'disabled');
    const staffLogin = staff?.passwordHash && passwordMatches(input.password || '', staff.passwordHash);
    if (!rootLogin && !staffLogin) {
      if (!adminPassword && !current.staff.length) return json(res, 503, { error: '管理员密码尚未配置' });
      return json(res, 401, { error: '管理员账号或密码错误' });
    }
    const identity = rootLogin
      ? { sub: adminUsername, role: 'superadmin', permissions: ['*'], kind: 'staff' }
      : { sub: staff.username, staffId: staff.id, role: staff.role, permissions: permissionsFor(staff.role, staff.permissions), kind: 'staff' };
    const token = signJwt(identity, config.adminSecret, 8 * 3600);
    await dataStore.update((next) => audit(next, identity.sub, 'admin.login', ip, `role=${identity.role}`));
    return json(res, 200, { admin: { username: identity.sub, role: identity.role, permissions: identity.permissions } }, adminSessionHeaders(token));
  }
  if (req.method === 'POST' && url.pathname === '/api/admin/auth/logout') {
    return json(res, 200, { ok: true }, adminSessionHeaders('', 0));
  }
  let admin = adminFrom(req);
  if (!admin) return json(res, 401, { error: '管理员会话已失效' });
  const data = await dataStore.read();
  if (admin.staffId) {
    const currentStaff = data.staff.find((item) => item.id === admin.staffId && item.status !== 'disabled');
    if (!currentStaff) return json(res, 401, { error: '员工账号已停用' }, adminSessionHeaders('', 0));
    admin = {
      ...admin,
      role: currentStaff.role,
      permissions: permissionsFor(currentStaff.role, currentStaff.permissions),
    };
  }
  if (req.method === 'GET' && url.pathname === '/api/admin/auth/session') {
    return json(res, 200, { admin: { username: admin.sub, role: admin.role, permissions: admin.permissions || permissionsFor(admin.role) } });
  }
  if (req.method === 'GET' && url.pathname === '/api/admin/dashboard') {
    assertAdminPermission(admin, 'dashboard.read');
    const completed = data.matches.length;
    const wins = data.matches.filter((item) => item.result === 'win').length;
    const days = Array.from({ length: 14 }, (_, offset) => {
      const date = new Date();
      date.setUTCHours(0, 0, 0, 0);
      date.setUTCDate(date.getUTCDate() - (13 - offset));
      const key = date.toISOString().slice(0, 10);
      return { date: key, matches: data.matches.filter((item) => item.createdAt?.slice(0, 10) === key).length };
    });
    return json(res, 200, {
      stats: {
        users: data.users.length,
        activeUsers: data.users.filter((item) => !item.disabled).length,
        matches: completed,
        winRate: completed ? Math.round(wins / completed * 1000) / 10 : 0,
        onlineRooms: new Set([
          ...(data.onlineRooms || []).filter((room) => Date.now() - Date.parse(room.updatedAt) < 10 * 60_000).map((room) => `${room.game}:${room.id}`),
          ...[...(rooms?.rooms.values() || [])].map((room) => `${room.gameId === 'gomoku' ? 'gobang' : room.gameId}:${room.id}`),
        ]).size,
      },
      trend: days,
      games: [...gameApps].map((game) => {
        const matches = data.matches.filter((item) => item.game === game);
        return { game, matches: matches.length, winRate: matches.length ? Math.round(matches.filter((item) => item.result === 'win').length / matches.length * 1000) / 10 : 0 };
      }),
    });
  }
  if (req.method === 'GET' && url.pathname === '/api/admin/users') {
    assertAdminPermission(admin, 'players.read');
    const q = String(url.searchParams.get('q') || '').toLowerCase();
    const status = url.searchParams.get('status') || 'all';
    const users = data.users.filter((item) => {
      const text = `${item.phone} ${item.nickname} ${item.id}`.toLowerCase();
      return (!q || text.includes(q)) && (status === 'all' || (status === 'disabled') === Boolean(item.disabled));
    }).map((item) => ({
      ...publicUser(item),
      matches: data.matches.filter((match) => match.userId === item.id).length,
    })).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
    return json(res, 200, { users });
  }
  const userMatch = url.pathname.match(/^\/api\/admin\/users\/([^/]+)$/);
  if (req.method === 'PATCH' && userMatch) {
    assertAdminPermission(admin, 'players.write');
    const input = await body(req);
    const disabled = Boolean(input.disabled);
    const updated = await dataStore.update((next) => {
      const user = next.users.find((item) => item.id === decodeURIComponent(userMatch[1]));
      if (!user) throw Object.assign(new Error('用户不存在'), { status: 404 });
      user.disabled = disabled;
      user.disabledAt = disabled ? new Date().toISOString() : null;
      audit(next, admin.sub, disabled ? 'user.disable' : 'user.enable', user.id, user.phone);
      return publicUser(user);
    });
    return json(res, 200, { user: updated });
  }
  if (req.method === 'GET' && url.pathname === '/api/admin/matches') {
    assertAdminPermission(admin, 'matches.read');
    const q = String(url.searchParams.get('q') || '').toLowerCase();
    const game = url.searchParams.get('game');
    const result = url.searchParams.get('result');
    const users = new Map(data.users.map((item) => [item.id, item]));
    const matches = data.matches.filter((item) => {
      const user = users.get(item.userId);
      const text = `${item.id} ${item.roomId || ''} ${user?.phone || ''} ${user?.nickname || ''}`.toLowerCase();
      return (!q || text.includes(q)) && (!game || game === 'all' || item.game === game) && (!result || result === 'all' || item.result === result);
    }).slice(-500).reverse().map((item) => ({ ...item, user: publicUser(users.get(item.userId) || {}) }));
    return json(res, 200, { matches });
  }
  if (req.method === 'GET' && url.pathname === '/api/admin/settings') {
    assertAdminPermission(admin, 'config.read');
    return json(res, 200, { settings: mergedSettings(data) });
  }
  if (req.method === 'PATCH' && url.pathname === '/api/admin/settings') {
    assertAdminPermission(admin, 'config.write');
    const input = await body(req);
    const settings = await dataStore.update((next) => {
      const current = mergedSettings(next);
      if ('announcement' in input) current.announcement = String(input.announcement || '').trim().slice(0, 500);
      for (const game of gameApps) {
        if (!input.games?.[game]) continue;
        if ('enabled' in input.games[game]) current.games[game].enabled = Boolean(input.games[game].enabled);
        if ('maintenance' in input.games[game]) current.games[game].maintenance = String(input.games[game].maintenance || '').trim().slice(0, 300);
      }
      next.settings = current;
      audit(next, admin.sub, 'settings.update', 'platform', JSON.stringify(current));
      return current;
    });
    return json(res, 200, { settings });
  }
  if (req.method === 'GET' && url.pathname === '/api/admin/rooms') {
    assertAdminPermission(admin, 'rooms.read');
    const roomMap = new Map((data.onlineRooms || [])
      .filter((room) => Date.now() - Date.parse(room.updatedAt) < 10 * 60_000)
      .map((room) => [`${room.game}:${room.id}`, room]));
    for (const room of rooms?.rooms.values() || []) {
      const summary = roomSummary(room);
      roomMap.set(`${summary.game}:${summary.id}`, summary);
    }
    const roomList = [...roomMap.values()].sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
    return json(res, 200, { rooms: roomList });
  }
  if (req.method === 'GET' && url.pathname === '/api/admin/audit-logs') {
    assertAdminPermission(admin, 'audit.read');
    return json(res, 200, { logs: (data.auditLogs || []).slice(-500).reverse() });
  }
  if (url.pathname.startsWith('/api/admin/liveops/')) {
    const handled = await handleLiveOpsApi({
      req,
      res,
      url,
      dataStore,
      admin: { ...admin, permissions: admin.permissions || permissionsFor(admin.role) },
      json,
      readBody: body,
      audit,
      publicUser,
      hashPassword,
    });
    if (handled !== false) return handled;
  }
  return json(res, 404, { error: '管理接口不存在' });
}

async function api(req, res, url, dataStore = store, rooms = null, app = config.app) {
  if (url.pathname.startsWith('/api/admin/')) {
    if (app !== 'admin') return json(res, 404, { error: '接口不存在' });
    return adminApi(req, res, url, dataStore, rooms);
  }
  const ip = req.socket.remoteAddress || 'unknown';
  if (url.pathname.startsWith('/api/auth/') && !authLimiter.consume(ip)) {
    return json(res, 429, { error: '尝试次数过多，请稍后再试' });
  }
  if (req.method === 'POST' && url.pathname === '/api/auth/sms/send') {
    const input = await body(req);
    if (!/^1\d{10}$/.test(input.phone || '')) return json(res, 400, { error: '手机号格式不正确' });
    if (!smsLimiter.consume(`${ip}:${input.phone}`)) return json(res, 429, { error: '验证码发送过于频繁' });
    const code = String(Math.floor(100000 + Math.random() * 900000));
    await dataStore.update((data) => {
      data.smsCodes = data.smsCodes.filter((item) => item.expiresAt > Date.now() && item.phone !== input.phone);
      data.smsCodes.push({ phone: input.phone, code, expiresAt: Date.now() + 5 * 60_000 });
    });
    return json(res, 200, await smsAdapter.send(input.phone, code));
  }
  if (req.method === 'POST' && url.pathname === '/api/auth/register') {
    const input = await body(req);
    if (!/^1\d{10}$/.test(input.phone || '') || String(input.password || '').length < 8) {
      return json(res, 400, { error: '请输入有效手机号和至少 8 位密码' });
    }
    const user = await dataStore.update((data) => {
      if (data.users.some((item) => item.phone === input.phone)) throw Object.assign(new Error('手机号已注册'), { status: 409 });
      const sms = data.smsCodes.find((item) => item.phone === input.phone && item.code === input.code && item.expiresAt > Date.now());
      if (!sms) throw Object.assign(new Error('验证码无效或已过期'), { status: 400 });
      const created = {
        id: randomBytes(12).toString('hex'),
        phone: input.phone,
        nickname: `玩家${input.phone.slice(-4)}`,
        bio: '一起认真玩。',
        passwordHash: hashPassword(input.password),
        createdAt: new Date().toISOString(),
      };
      data.users.push(created);
      data.smsCodes = data.smsCodes.filter((item) => item.phone !== input.phone);
      return created;
    });
    return json(res, 201, { user: publicUser(user) }, sessionHeaders(tokenFor(user)));
  }
  if (req.method === 'POST' && url.pathname === '/api/auth/sms/login') {
    const input = await body(req);
    if (!/^1\d{10}$/.test(input.phone || '')) return json(res, 400, { error: '手机号格式不正确' });
    const user = await dataStore.update((data) => {
      if (!validSms(data, input.phone, input.code)) throw Object.assign(new Error('验证码无效或已过期'), { status: 400 });
      const existing = data.users.find((item) => item.phone === input.phone);
      if (!existing) throw Object.assign(new Error('该手机号尚未注册，请先创建账户'), { status: 404 });
      assertActive(existing);
      data.smsCodes = data.smsCodes.filter((item) => item.phone !== input.phone);
      return existing;
    });
    return json(res, 200, { user: publicUser(user) }, sessionHeaders(tokenFor(user)));
  }
  if (req.method === 'POST' && url.pathname === '/api/auth/login') {
    const input = await body(req);
    const data = await dataStore.read();
    const user = data.users.find((item) => item.phone === input.phone);
    if (!user || !passwordMatches(input.password || '', user.passwordHash)) {
      return json(res, 401, { error: '手机号或密码错误' });
    }
    assertActive(user);
    return json(res, 200, { user: publicUser(user) }, sessionHeaders(tokenFor(user)));
  }
  if (req.method === 'POST' && url.pathname === '/api/auth/logout') {
    return json(res, 200, { ok: true }, { 'set-cookie': 'session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0' });
  }
  if (req.method === 'GET' && url.pathname === '/api/auth/wechat/web') {
    if (!config.wechatWebAppId || !config.wechatWebSecret) return json(res, 503, { error: '未配置微信网站应用登录' });
    const redirect = encodeURIComponent(`${config.publicOrigin}/api/auth/wechat/callback`);
    const state = randomBytes(12).toString('hex');
    const stateToken = signJwt({ oauthState: state }, config.jwtSecret, 10 * 60);
    return json(res, 200, {
      url: `https://open.weixin.qq.com/connect/qrconnect?appid=${config.wechatWebAppId}&redirect_uri=${redirect}&response_type=code&scope=snsapi_login&state=${state}#wechat_redirect`,
    }, { 'set-cookie': `wechat_oauth_state=${stateToken}; HttpOnly; SameSite=Lax; Path=/; Max-Age=600${process.env.NODE_ENV === 'production' ? '; Secure' : ''}` });
  }
  if (req.method === 'GET' && url.pathname === '/api/auth/wechat/callback') {
    const statePayload = verifyJwt(cookies(req).wechat_oauth_state, config.jwtSecret);
    if (!url.searchParams.get('code') || !statePayload || statePayload.oauthState !== url.searchParams.get('state')) {
      return json(res, 400, { error: '微信授权状态无效，请重新登录' });
    }
    const endpoint = new URL('https://api.weixin.qq.com/sns/oauth2/access_token');
    endpoint.search = new URLSearchParams({
      appid: config.wechatWebAppId,
      secret: config.wechatWebSecret,
      code: url.searchParams.get('code'),
      grant_type: 'authorization_code'
    });
    const result = await (await fetch(endpoint)).json();
    if (!result.openid) return json(res, 401, { error: result.errmsg || '微信登录失败' });
    const user = await upsertWechatUser(`web:${result.unionid || result.openid}`, dataStore);
    assertActive(user);
    res.writeHead(302, {
      location: '/',
      ...sessionHeaders(tokenFor(user)),
      'set-cookie': [
        sessionHeaders(tokenFor(user))['set-cookie'],
        'wechat_oauth_state=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0'
      ]
    });
    return res.end();
  }
  if (req.method === 'POST' && url.pathname === '/api/auth/wechat/mini') {
    const input = await body(req);
    if (!config.wechatMiniAppId || !config.wechatMiniSecret) return json(res, 503, { error: '微信小程序登录未配置' });
    if (!input.code) return json(res, 400, { error: '缺少小程序 code' });
    const endpoint = new URL('https://api.weixin.qq.com/sns/jscode2session');
    endpoint.search = new URLSearchParams({ appid: config.wechatMiniAppId, secret: config.wechatMiniSecret, js_code: input.code, grant_type: 'authorization_code' });
    const response = await fetch(endpoint);
    const result = await response.json();
    if (!result.openid) return json(res, 401, { error: result.errmsg || '微信登录失败' });
    const user = await upsertWechatUser(`mini:${result.openid}`, dataStore);
    assertActive(user);
    return json(res, 200, { user: publicUser(user) }, sessionHeaders(tokenFor(user)));
  }
  if (req.method === 'GET' && url.pathname === '/api/config') {
    const data = await dataStore.read();
    return json(res, 200, { settings: mergedSettings(data), remoteConfig: data.remoteConfig || {} });
  }
  const data = await dataStore.read();
  const user = userFrom(req, data);
  if (!user) return json(res, 401, { error: '请先登录' });
  assertActive(user);
  if (req.method === 'GET' && url.pathname === '/api/me') return json(res, 200, { user: publicUser(user) });
  if (req.method === 'PATCH' && url.pathname === '/api/me') {
    const input = await body(req);
    const nickname = String(input.nickname || '').trim().slice(0, 20);
    const bio = String(input.bio || '').trim().slice(0, 80);
    if (!nickname) return json(res, 400, { error: '昵称不能为空' });
    await dataStore.update((next) => Object.assign(next.users.find((item) => item.id === user.id), { nickname, bio }));
    return json(res, 200, { user: { ...publicUser(user), nickname, bio } });
  }
  if (req.method === 'GET' && url.pathname === '/api/matches') {
    return json(res, 200, { matches: data.matches.filter((item) => item.userId === user.id).slice(-50).reverse() });
  }
  if (req.method === 'POST' && url.pathname === '/api/matches') {
    const input = await body(req);
    if (!gameApps.has(input.game) || !['win', 'loss', 'draw'].includes(input.result)) {
      return json(res, 400, { error: '战绩数据无效' });
    }
    const gameConfig = mergedSettings(data).games[input.game];
    if (!gameConfig.enabled) return json(res, 503, { error: gameConfig.maintenance || '游戏维护中' });
    const match = {
      id: randomBytes(10).toString('hex'),
      userId: user.id,
      game: input.game,
      result: input.result,
      detail: String(input.detail || '').slice(0, 120),
      createdAt: new Date().toISOString(),
    };
    await dataStore.update((next) => next.matches.push(match));
    return json(res, 201, { match });
  }
  return json(res, 404, { error: '接口不存在' });
}

async function upsertWechatUser(wechatId, dataStore = store) {
  return dataStore.update((data) => {
    let user = data.users.find((item) => item.wechatId === wechatId);
    if (!user) {
      user = {
        id: randomBytes(12).toString('hex'),
        phone: `wx_${randomBytes(8).toString('hex')}`,
        nickname: '微信玩家',
        bio: '一起认真玩。',
        wechatId,
        passwordHash: hashPassword(randomBytes(24).toString('hex')),
        createdAt: new Date().toISOString(),
      };
      data.users.push(user);
    }
    return user;
  });
}

async function staticFile(req, res, url) {
  const builtBase = path.join(root, 'dist', 'apps', config.app);
  const sourceBase = path.join(root, 'src', 'apps', config.app);
  const base = sourceBase;
  const requested = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
  let file = path.resolve(base, requested);
  if (!file.startsWith(`${base}${path.sep}`) && file !== path.join(base, 'index.html')) return json(res, 403, { error: '禁止访问' });
  try {
    let content;
    try {
      file = requested.startsWith('shared/')
        ? path.join(root, 'src', requested)
        : path.resolve(sourceBase, requested);
      content = await readFile(file);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      file = path.resolve(builtBase, requested);
      content = await readFile(file);
    }
    const types = {
      '.html': 'text/html; charset=utf-8',
      '.js': 'text/javascript; charset=utf-8',
      '.css': 'text/css; charset=utf-8',
      '.svg': 'image/svg+xml',
      '.webmanifest': 'application/manifest+json'
    };
    res.writeHead(200, {
      'content-type': types[path.extname(file)] || 'application/octet-stream',
      'cache-control': requested === 'index.html' ? 'no-cache' : 'public, max-age=3600',
    });
    res.end(content);
  } catch {
    json(res, 404, { error: '资源不存在，请先运行 npm run build' });
  }
}

function websocketUser(request, data) {
  return userFrom(request, data);
}

async function recordRoomResult(dataStore, room, result) {
  await dataStore.update((data) => {
    for (const player of room.players) {
      if (!player.userId) continue;
      const outcome = result.draw ? 'draw' : result.winners.includes(player.index) ? 'win' : 'loss';
      data.matches.push({
        id: randomBytes(10).toString('hex'),
        userId: player.userId,
        game: room.gameId === 'gomoku' ? 'gobang' : room.gameId,
        result: outcome,
        detail: result.detail || `联网房间 ${room.id}`,
        roomId: room.id,
        createdAt: new Date().toISOString()
      });
    }
  });
}

export function createApp({ requireAuth = false, app = config.app, dataStore = store } = {}) {
  const gameId = app === 'admin' ? null : app === 'gobang' ? 'gomoku' : app;
  const reportRoom = (room) => dataStore.update((data) => {
    data.onlineRooms ||= [];
    const summary = roomSummary(room);
    const index = data.onlineRooms.findIndex((item) => item.id === summary.id && item.game === summary.game);
    if (index >= 0) data.onlineRooms[index] = summary;
    else data.onlineRooms.push(summary);
    data.onlineRooms = data.onlineRooms.filter((item) => Date.now() - Date.parse(item.updatedAt) < 10 * 60_000);
  });
  const rooms = new RoomManager({
    games: [gomoku, doudizhu, mahjong],
    onFinished: (room, result) => recordRoomResult(dataStore, room, result),
    onChanged: reportRoom,
  });
  const server = http.createServer(async (req, res) => {
    res.setHeader('x-content-type-options', 'nosniff');
    res.setHeader('referrer-policy', 'same-origin');
    res.setHeader('content-security-policy', "default-src 'self'; style-src 'self'; script-src 'self'; img-src 'self' data:; connect-src 'self'");
    const url = new URL(req.url, config.publicOrigin);
    try {
      if (url.pathname.startsWith('/api/')) await api(req, res, url, dataStore, rooms, app);
      else await staticFile(req, res, url);
    } catch (error) {
      if (!error.status || error.status >= 500) console.error(error);
      json(res, error.status || 500, {
        error: error.status ? error.message : '服务器暂时不可用',
        ...(error.code && { code: error.code }),
        ...(error.action && { action: error.action }),
      });
    }
  });
  const wss = new WebSocketServer({ noServer: true, maxPayload: 16_384 });
  server.on('upgrade', async (request, socket, head) => {
    const url = new URL(request.url, config.publicOrigin);
    if (url.pathname !== '/ws') return socket.destroy();
    if (app === 'admin') {
      socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
      return socket.destroy();
    }
    const currentData = await dataStore.read();
    const user = websocketUser(request, currentData);
    if (requireAuth && !user) {
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      return socket.destroy();
    }
    if (user?.disabled) {
      socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      return socket.destroy();
    }
    const appSettings = gameApps.has(app) ? mergedSettings(currentData).games[app] : null;
    if (appSettings && !appSettings.enabled) {
      socket.write('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n');
      return socket.destroy();
    }
    request.user = user;
    wss.handleUpgrade(request, socket, head, ws => wss.emit('connection', ws, request));
  });
  const realtime = new RealtimeServer({
    webSocketServer: wss,
    rooms,
    gameId: requireAuth ? gameId : null,
    authorize: async (socket, message) => {
      const data = await dataStore.read();
      const freshUser = data.users.find((item) => item.id === socket.identity?.id);
      if (requireAuth && (!freshUser || freshUser.disabled)) throw Object.assign(new Error('账号已被禁用'), { code: 'ACCOUNT_DISABLED' });
      const room = rooms.get(socket.roomId);
      const targetGame = message.type === 'create' ? (message.gameId || gameId) : room?.gameId || gameId;
      const key = targetGame === 'gomoku' ? 'gobang' : targetGame;
      const gameConfig = mergedSettings(data).games[key];
      if (gameConfig && !gameConfig.enabled) throw Object.assign(new Error(gameConfig.maintenance || '游戏维护中'), { code: 'GAME_DISABLED' });
    },
  }).start();
  const roomHeartbeat = gameApps.has(app) ? setInterval(() => {
    for (const room of rooms.rooms.values()) reportRoom(room).catch(() => {});
  }, 60_000) : null;
  roomHeartbeat?.unref?.();
  const stopRealtime = realtime.stop.bind(realtime);
  realtime.stop = () => {
    if (roomHeartbeat) clearInterval(roomHeartbeat);
    stopRealtime();
  };
  return { server, wss, realtime, rooms };
}

export function createServer() {
  return createApp({ requireAuth: true }).server;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { server, realtime } = createApp({ requireAuth: true });
  server.listen(config.port, () => {
    console.log(`${config.app} ready at ${config.publicOrigin}`);
  });
  const shutdown = () => {
    realtime.stop();
    server.close(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

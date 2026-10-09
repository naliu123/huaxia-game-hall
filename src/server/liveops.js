import { randomBytes } from 'node:crypto';

export const ROLE_PERMISSIONS = {
  superadmin: ['*'],
  operator: ['dashboard.read', 'players.write', 'matches.read', 'rooms.read', 'audit.read', 'segments.write', 'campaigns.write', 'config.write', 'experiments.write', 'economy.write', 'orders.write', 'leaderboards.write', 'health.read', 'export.read'],
  support: ['dashboard.read', 'players.read', 'matches.read', 'messages.write', 'orders.read', 'tickets.write', 'compensation.write', 'reports.read'],
  moderator: ['dashboard.read', 'players.read', 'matches.read', 'reports.write', 'risk.write', 'punishments.write'],
  analyst: ['dashboard.read', 'players.read', 'matches.read', 'audit.read', 'segments.read', 'experiments.read', 'economy.read', 'orders.read', 'leaderboards.read', 'health.read', 'export.read'],
};

export const LIVEOPS_COLLECTIONS = [
  'staff', 'segments', 'campaigns', 'tasks', 'messages', 'deliveries',
  'configVersions', 'experiments', 'catalog', 'inventoryLedger', 'orders',
  'seasons', 'leaderboards', 'tickets', 'compensations', 'reports',
  'riskRules', 'riskCases', 'punishments', 'healthMetrics', 'alerts',
];

const RESOURCE_PERMISSION = {
  staff: 'rbac', segments: 'segments', campaigns: 'campaigns', tasks: 'campaigns',
  messages: 'messages', deliveries: 'messages', configVersions: 'config',
  experiments: 'experiments', catalog: 'economy', inventoryLedger: 'economy',
  orders: 'orders', seasons: 'leaderboards', leaderboards: 'leaderboards',
  tickets: 'tickets', compensations: 'compensation', reports: 'reports',
  riskRules: 'risk', riskCases: 'risk', punishments: 'punishments',
  healthMetrics: 'health', alerts: 'health',
};

const DANGEROUS_ACTIONS = new Set([
  'config.publish', 'config.rollback', 'inventory.adjust', 'order.refund',
  'ticket.compensate', 'punishment.issue', 'staff.disable',
]);

export function ensureLiveOpsData(data) {
  for (const key of LIVEOPS_COLLECTIONS) data[key] ||= [];
  data.adapters ||= {
    sms: { status: 'unconfigured', mode: 'adapter-only' },
    push: { status: 'unconfigured', mode: 'adapter-only' },
    email: { status: 'unconfigured', mode: 'adapter-only' },
    payment: { status: 'unconfigured', mode: 'adapter-only' },
  };
  return data;
}

export function permissionsFor(role, explicit = []) {
  const permissions = [...(ROLE_PERMISSIONS[role] || []), ...explicit];
  for (const permission of [...permissions]) {
    if (permission.endsWith('.write')) permissions.push(permission.replace('.write', '.read'));
  }
  return [...new Set(permissions)];
}

export function can(admin, permission) {
  const permissions = admin?.permissions || permissionsFor(admin?.role);
  return permissions.includes('*') || permissions.includes(permission);
}

function id(prefix) {
  return `${prefix}_${randomBytes(8).toString('hex')}`;
}

function clean(value, depth = 0) {
  if (depth > 5) return null;
  if (typeof value === 'string') return value.trim().slice(0, 4000);
  if (Array.isArray(value)) return value.slice(0, 200).map(item => clean(item, depth + 1));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value)
      .filter(([key]) => !['id', 'createdAt', 'updatedAt', 'createdBy', 'passwordHash', 'password', 'token', 'secret'].includes(key))
      .slice(0, 100)
      .map(([key, item]) => [key, clean(item, depth + 1)]));
  }
  return value;
}

function requirePermission(admin, permission) {
  if (!can(admin, permission)) throw Object.assign(new Error(`缺少权限：${permission}`), { status: 403 });
}

function requireConfirmation(req, input, action) {
  if (!DANGEROUS_ACTIONS.has(action)) return;
  const confirmation = req.headers['x-confirm-action'] || input.confirm;
  if (confirmation !== action) {
    throw Object.assign(new Error(`危险操作需要确认：${action}`), {
      status: 428,
      code: 'CONFIRMATION_REQUIRED',
      action,
    });
  }
}

function statusFor(resource, input) {
  if (input.status) return input.status;
  if (resource === 'messages') return 'draft';
  if (resource === 'configVersions') return 'draft';
  if (resource === 'experiments') return 'draft';
  if (resource === 'orders') return 'pending';
  if (resource === 'tickets' || resource === 'reports' || resource === 'riskCases') return 'open';
  if (resource === 'alerts') return 'firing';
  return 'active';
}

function csvCell(value) {
  const text = typeof value === 'object' ? JSON.stringify(value) : String(value ?? '');
  return `"${text.replaceAll('"', '""')}"`;
}

function exportRows(rows, format) {
  if (format === 'json') return JSON.stringify(rows, null, 2);
  const keys = [...new Set(rows.flatMap(row => Object.keys(row)))];
  return [keys.map(csvCell).join(','), ...rows.map(row => keys.map(key => csvCell(row[key])).join(','))].join('\n');
}

function playerProfile(data, userId, publicUser) {
  const user = data.users.find(item => item.id === userId);
  if (!user) throw Object.assign(new Error('玩家不存在'), { status: 404 });
  const matches = data.matches.filter(item => item.userId === userId);
  const ledger = data.inventoryLedger.filter(item => item.userId === userId);
  const orders = data.orders.filter(item => item.userId === userId);
  const tickets = data.tickets.filter(item => item.userId === userId);
  const reports = data.reports.filter(item => item.userId === userId || item.reporterId === userId);
  const timeline = [
    ...matches.map(item => ({ type: 'match', at: item.createdAt, detail: `${item.game}:${item.result}`, ref: item.id })),
    ...ledger.map(item => ({ type: 'ledger', at: item.createdAt, detail: `${item.asset || 'asset'} ${Number(item.delta || 0)}`, ref: item.id })),
    ...orders.map(item => ({ type: 'order', at: item.createdAt, detail: item.status, ref: item.id })),
    ...tickets.map(item => ({ type: 'ticket', at: item.createdAt, detail: item.status, ref: item.id })),
    ...reports.map(item => ({ type: 'report', at: item.createdAt, detail: item.status, ref: item.id })),
  ].sort((a, b) => String(b.at).localeCompare(String(a.at))).slice(0, 200);
  return {
    user: publicUser(user),
    summary: {
      matches: matches.length,
      wins: matches.filter(item => item.result === 'win').length,
      orders: orders.length,
      tickets: tickets.length,
      reports: reports.length,
    },
    balances: Object.fromEntries([...new Set(ledger.map(item => item.asset || 'coin'))]
      .map(asset => [asset, ledger.filter(item => (item.asset || 'coin') === asset).reduce((sum, item) => sum + Number(item.delta || 0), 0)])),
    timeline,
  };
}

export async function handleLiveOpsApi(context) {
  const { req, res, url, dataStore, admin, json, readBody, audit, publicUser, hashPassword } = context;
  const relative = url.pathname.replace('/api/admin/liveops/', '');
  const parts = relative.split('/').filter(Boolean).map(decodeURIComponent);
  const data = ensureLiveOpsData(await dataStore.read());

  if (req.method === 'GET' && relative === 'bootstrap') {
    requirePermission(admin, 'dashboard.read');
    const counts = Object.fromEntries(LIVEOPS_COLLECTIONS.map(key => [key, data[key].length]));
    return json(res, 200, {
      actor: { username: admin.sub, role: admin.role, permissions: admin.permissions },
      counts,
      adapters: data.adapters,
      recentAlerts: data.alerts.slice(-5).reverse(),
      activeCampaigns: data.campaigns.filter(item => item.status === 'active').slice(-5),
    });
  }

  if (req.method === 'GET' && relative === 'analytics') {
    requirePermission(admin, 'dashboard.read');
    const matchesByUser = new Map();
    for (const match of data.matches) {
      if (!matchesByUser.has(match.userId)) matchesByUser.set(match.userId, []);
      matchesByUser.get(match.userId).push(match);
    }
    const played = data.users.filter(user => matchesByUser.has(user.id));
    const repeat = played.filter(user => matchesByUser.get(user.id).length >= 2);
    const won = played.filter(user => matchesByUser.get(user.id).some(match => match.result === 'win'));
    const retention = {};
    for (const day of [1, 7, 30]) {
      const eligible = data.users.filter(user => Date.now() - Date.parse(user.createdAt) >= day * 86_400_000);
      const retained = eligible.filter(user => {
        const registered = new Date(user.createdAt);
        const target = new Date(registered);
        target.setUTCDate(target.getUTCDate() + day);
        const targetDay = target.toISOString().slice(0, 10);
        return (matchesByUser.get(user.id) || []).some(match => match.createdAt?.slice(0, 10) === targetDay);
      });
      retention[`d${day}`] = { eligible: eligible.length, users: retained.length, rate: eligible.length ? Math.round(retained.length / eligible.length * 1000) / 10 : 0 };
    }
    const cohorts = new Map();
    for (const user of data.users) {
      const date = new Date(user.createdAt);
      if (Number.isNaN(date.getTime())) continue;
      const day = date.getUTCDay() || 7;
      date.setUTCDate(date.getUTCDate() - day + 1);
      const week = date.toISOString().slice(0, 10);
      if (!cohorts.has(week)) cohorts.set(week, { week, users: 0, activated: 0, repeat: 0 });
      const cohort = cohorts.get(week);
      cohort.users++;
      const userMatches = matchesByUser.get(user.id) || [];
      if (userMatches.length) cohort.activated++;
      if (userMatches.length >= 2) cohort.repeat++;
    }
    return json(res, 200, {
      funnel: [
        { stage: '注册', users: data.users.length },
        { stage: '完成首局', users: played.length },
        { stage: '完成两局', users: repeat.length },
        { stage: '获得胜局', users: won.length },
      ],
      retention,
      cohorts: [...cohorts.values()].sort((a, b) => b.week.localeCompare(a.week)).slice(0, 8),
      gameMix: Object.fromEntries(['gobang', 'doudizhu', 'mahjong'].map(game => [game, data.matches.filter(match => match.game === game).length])),
    });
  }

  if (req.method === 'GET' && parts[0] === 'players' && parts[1]) {
    requirePermission(admin, 'players.read');
    return json(res, 200, { profile: playerProfile(data, parts[1], publicUser) });
  }

  if (req.method === 'GET' && parts[0] === 'export' && parts[1]) {
    requirePermission(admin, 'export.read');
    const resource = parts[1];
    const rows = resource === 'users'
      ? data.users.map(publicUser)
      : resource === 'staff'
        ? data.staff.map(({ passwordHash, ...item }) => item)
        : data[resource];
    if (!Array.isArray(rows)) return json(res, 404, { error: '不支持导出该资源' });
    const format = url.searchParams.get('format') === 'json' ? 'json' : 'csv';
    const output = exportRows(rows, format);
    res.writeHead(200, {
      'content-type': format === 'json' ? 'application/json; charset=utf-8' : 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="${resource}.${format}"`,
      'cache-control': 'no-store',
    });
    return res.end(output);
  }

  const resource = parts[0];
  if (!LIVEOPS_COLLECTIONS.includes(resource)) return false;
  const domain = RESOURCE_PERMISSION[resource];

  if (req.method === 'GET' && parts.length === 1) {
    requirePermission(admin, `${domain}.read`);
    const q = String(url.searchParams.get('q') || '').toLowerCase();
    const status = url.searchParams.get('status');
    const rows = data[resource].filter(item =>
      (!q || JSON.stringify(item).toLowerCase().includes(q)) &&
      (!status || status === 'all' || item.status === status)
    ).slice(-500).reverse().map(item => resource === 'staff' ? { ...item, passwordHash: undefined } : item);
    return json(res, 200, { resource, rows });
  }

  if (req.method === 'POST' && parts.length === 1) {
    requirePermission(admin, `${domain}.write`);
    const input = await readBody(req);
    const createConfirmation = {
      inventoryLedger: 'inventory.adjust',
      compensations: 'ticket.compensate',
      punishments: 'punishment.issue',
    }[resource];
    if (createConfirmation) requireConfirmation(req, input, createConfirmation);
    const created = await dataStore.update(next => {
      ensureLiveOpsData(next);
      const now = new Date().toISOString();
      if (resource === 'inventoryLedger') {
        const userId = String(input.userId || '');
        const asset = String(input.asset || 'coin').slice(0, 80);
        const delta = Number(input.delta);
        const idempotencyKey = String(input.idempotencyKey || id('manual')).slice(0, 160);
        if (!next.users.some(user => user.id === userId) || !Number.isFinite(delta) || delta === 0) {
          throw Object.assign(new Error('有效玩家、资产和非零变动值为必填项'), { status: 400 });
        }
        const duplicate = next.inventoryLedger.find(entry => entry.idempotencyKey === idempotencyKey);
        if (duplicate) return duplicate;
        const balanceBefore = next.inventoryLedger
          .filter(entry => entry.userId === userId && entry.asset === asset && entry.status === 'committed')
          .reduce((sum, entry) => sum + Number(entry.delta || 0), 0);
        const entry = {
          id: id('ledger'), userId, asset, delta, balanceBefore, balanceAfter: balanceBefore + delta,
          reason: String(input.reason || '').slice(0, 300), idempotencyKey, status: 'committed',
          createdAt: now, updatedAt: now, createdBy: admin.sub,
        };
        next.inventoryLedger.push(entry);
        audit(next, admin.sub, 'inventoryLedger.create', entry.id, JSON.stringify(entry));
        return entry;
      }
      const item = {
        ...clean(input),
        id: id(resource.replace(/[A-Z]/g, letter => `_${letter.toLowerCase()}`)),
        status: statusFor(resource, input),
        createdAt: now,
        updatedAt: now,
        createdBy: admin.sub,
      };
      if (resource === 'staff') {
        if (!input.username || String(input.password || '').length < 10 || !ROLE_PERMISSIONS[input.role]) {
          throw Object.assign(new Error('员工账号、至少 10 位密码和有效角色为必填项'), { status: 400 });
        }
        if (next.staff.some(staff => staff.username === input.username)) throw Object.assign(new Error('员工账号已存在'), { status: 409 });
        item.passwordHash = hashPassword(input.password);
        delete item.password;
        item.permissions = permissionsFor(item.role, input.permissions);
      }
      next[resource].push(item);
      audit(next, admin.sub, `${resource}.create`, item.id, JSON.stringify(clean(input)));
      return resource === 'staff' ? { ...item, passwordHash: undefined } : item;
    });
    return json(res, 201, { item: created });
  }

  const itemId = parts[1];
  if (req.method === 'PATCH' && itemId && parts.length === 2) {
    requirePermission(admin, `${domain}.write`);
    const input = await readBody(req);
    if (resource === 'staff' && input.status === 'disabled') requireConfirmation(req, input, 'staff.disable');
    const updated = await dataStore.update(next => {
      ensureLiveOpsData(next);
      const item = next[resource].find(row => row.id === itemId);
      if (!item) throw Object.assign(new Error('记录不存在'), { status: 404 });
      Object.assign(item, clean(input), { updatedAt: new Date().toISOString(), updatedBy: admin.sub });
      if (resource === 'staff') {
        delete item.password;
        if (input.password) item.passwordHash = hashPassword(input.password);
        if (input.role || input.permissions) item.permissions = permissionsFor(item.role, input.permissions || item.permissions);
      }
      audit(next, admin.sub, `${resource}.update`, item.id, JSON.stringify(clean(input)));
      return resource === 'staff' ? { ...item, passwordHash: undefined } : item;
    });
    return json(res, 200, { item: updated });
  }

  if (req.method !== 'POST' || !itemId || !parts[2]) return false;
  const action = parts[2];
  const actionKey = {
    configVersions: { publish: 'config.publish', rollback: 'config.rollback' },
    inventoryLedger: { adjust: 'inventory.adjust' },
    orders: { refund: 'order.refund' },
    tickets: { compensate: 'ticket.compensate' },
    punishments: { issue: 'punishment.issue' },
    alerts: { acknowledge: 'alert.acknowledge' },
    messages: { send: 'message.send' },
  }[resource]?.[action];
  if (!actionKey) return false;
  requirePermission(admin, `${domain}.write`);
  const input = await readBody(req);
  requireConfirmation(req, input, actionKey);
  const result = await dataStore.update(next => {
    ensureLiveOpsData(next);
    const item = next[resource].find(row => row.id === itemId);
    if (!item) throw Object.assign(new Error('记录不存在'), { status: 404 });
    const now = new Date().toISOString();
    if (actionKey === 'config.publish') {
      next.configVersions.forEach(row => { if (row.status === 'published') row.status = 'superseded'; });
      item.status = 'published';
      item.publishedAt = now;
      next.remoteConfig = clean(item.payload || {});
    } else if (actionKey === 'config.rollback') {
      const source = clean(item);
      const restored = { ...source, id: id('config'), status: 'published', rollbackOf: item.id, createdAt: now, updatedAt: now, createdBy: admin.sub };
      next.configVersions.forEach(row => { if (row.status === 'published') row.status = 'superseded'; });
      next.configVersions.push(restored);
      next.remoteConfig = clean(restored.payload || {});
      audit(next, admin.sub, actionKey, restored.id, `rollbackOf=${item.id}`);
      return restored;
    } else if (actionKey === 'inventory.adjust') {
      const entry = { id: id('ledger'), userId: input.userId, asset: input.asset || 'coin', delta: Number(input.delta), reason: input.reason || '', referenceId: item.id, status: 'committed', createdAt: now, createdBy: admin.sub };
      if (!entry.userId || !Number.isFinite(entry.delta) || !entry.delta) throw Object.assign(new Error('玩家、资产和非零变动值为必填项'), { status: 400 });
      next.inventoryLedger.push(entry);
      audit(next, admin.sub, actionKey, entry.id, JSON.stringify(entry));
      return entry;
    } else if (actionKey === 'order.refund') {
      if (!['paid', 'partially_refunded'].includes(item.status)) throw Object.assign(new Error('当前订单状态不可退款'), { status: 409 });
      const refundAmount = Number(input.amount);
      if (!Number.isFinite(refundAmount) || refundAmount <= 0 || refundAmount > Number(item.amount)) {
        throw Object.assign(new Error('退款金额必须大于 0 且不超过订单金额'), { status: 400 });
      }
      item.status = refundAmount < Number(item.amount) ? 'partial_refund_pending' : 'refund_pending';
      item.refundAmount = refundAmount;
      item.refundReason = String(input.reason || '').slice(0, 300);
      item.refundStatus = 'awaiting_adapter';
      item.paymentAdapterStatus = data.adapters.payment.status;
      item.refundRequestedAt = now;
    } else if (actionKey === 'ticket.compensate') {
      const compensation = { id: id('comp'), ticketId: item.id, userId: item.userId, items: clean(input.items || []), reason: input.reason || '', status: 'granted', createdAt: now, createdBy: admin.sub };
      if (!next.users.some(user => user.id === compensation.userId) || !Array.isArray(compensation.items) || !compensation.items.length) {
        throw Object.assign(new Error('工单玩家和补偿内容无效'), { status: 400 });
      }
      next.compensations.push(compensation);
      for (const reward of compensation.items) {
        const asset = String(reward.asset || 'coin').slice(0, 80);
        const delta = Number(reward.amount);
        if (!Number.isFinite(delta) || delta <= 0) throw Object.assign(new Error('补偿数量必须为正数'), { status: 400 });
        const balanceBefore = next.inventoryLedger
          .filter(entry => entry.userId === compensation.userId && entry.asset === asset && entry.status === 'committed')
          .reduce((sum, entry) => sum + Number(entry.delta || 0), 0);
        next.inventoryLedger.push({
          id: id('ledger'), userId: compensation.userId, asset, delta, balanceBefore, balanceAfter: balanceBefore + delta,
          reason: compensation.reason, referenceId: compensation.id, idempotencyKey: `${compensation.id}:${asset}`,
          status: 'committed', createdAt: now, createdBy: admin.sub,
        });
      }
      item.status = 'resolved';
      audit(next, admin.sub, actionKey, compensation.id, JSON.stringify(compensation));
      return compensation;
    } else if (actionKey === 'punishment.issue') {
      item.status = 'active';
      item.issuedAt = now;
      if (item.type === 'account_ban') {
        const user = next.users.find(user => user.id === item.userId);
        if (user) {
          user.disabled = true;
          user.disabledAt = now;
          user.disabledReason = item.reason || '风控处罚';
        }
      }
    } else if (actionKey === 'alert.acknowledge') {
      item.status = 'acknowledged';
      item.acknowledgedAt = now;
    } else if (actionKey === 'message.send') {
      item.status = 'queued';
      item.queuedAt = now;
      item.adapterStatus = data.adapters[item.channel || 'push']?.status || 'unconfigured';
    }
    item.updatedAt = now;
    item.updatedBy = admin.sub;
    audit(next, admin.sub, actionKey, item.id, JSON.stringify(clean(input)));
    return item;
  });
  return json(res, 200, { item: result });
}

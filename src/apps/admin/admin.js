const app = document.querySelector('#app');
const gameNames = { gobang: '五子棋', doudizhu: '斗地主', mahjong: '麻将' };
const groups = [
  ['总览', [['dashboard', '运营总览'], ['analytics', '留存与漏斗'], ['healthMetrics', '健康与告警']]],
  ['玩家', [['users', '玩家画像'], ['segments', '玩家分群'], ['messages', '站内信与触达']]],
  ['运营', [['campaigns', '活动日历'], ['configVersions', '远程配置'], ['experiments', 'A/B 实验']]],
  ['商业化', [['catalog', '货币与商品'], ['orders', '订单退款'], ['seasons', '排行榜赛季']]],
  ['服务与安全', [['tickets', '客服工单'], ['reports', '举报审核'], ['riskRules', '风控中心']]],
  ['系统', [['staff', '员工与权限'], ['settings', '游戏开关'], ['rooms', '在线房间'], ['audit', '审计日志']]],
];
const labels = Object.fromEntries(groups.flatMap(([, items]) => items));
const resourceMeta = {
  staff: ['员工', 'username', 'role', 'status'], segments: ['分群', 'name', 'rule', 'status'],
  messages: ['消息', 'title', 'channel', 'status'], campaigns: ['活动 / 任务', 'name', 'startsAt', 'status'],
  tasks: ['活动任务', 'name', 'campaignId', 'status'], deliveries: ['触达记录', 'messageId', 'channel', 'status'],
  configVersions: ['配置版本', 'name', 'version', 'status'], experiments: ['实验', 'name', 'hypothesis', 'status'],
  catalog: ['商品', 'name', 'price', 'status'], orders: ['订单', 'userId', 'amount', 'status'],
  inventoryLedger: ['库存账本', 'userId', 'asset', 'delta'],
  seasons: ['赛季', 'name', 'endsAt', 'status'], tickets: ['工单', 'userId', 'subject', 'status'],
  leaderboards: ['榜单记录', 'seasonId', 'userId', 'score'], compensations: ['补偿记录', 'ticketId', 'userId', 'status'],
  reports: ['举报', 'userId', 'reason', 'status'], riskRules: ['风控规则', 'name', 'condition', 'status'],
  riskCases: ['风控案件', 'userId', 'ruleId', 'status'], punishments: ['处罚', 'userId', 'type', 'status'],
  healthMetrics: ['健康指标', 'name', 'value', 'status'], alerts: ['告警', 'name', 'severity', 'status'],
};
const relatedResources = {
  messages: ['messages', 'deliveries'], campaigns: ['campaigns', 'tasks'],
  catalog: ['catalog', 'inventoryLedger'], seasons: ['seasons', 'leaderboards'],
  tickets: ['tickets', 'compensations'], riskRules: ['riskRules', 'riskCases', 'punishments'],
  healthMetrics: ['healthMetrics', 'alerts'],
};
const state = { admin: null, view: 'dashboard', timer: null };

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
}
async function api(url, options = {}) {
  const response = await fetch(url, { ...options, headers: { 'content-type': 'application/json', ...options.headers } });
  const type = response.headers.get('content-type') || '';
  const result = type.includes('json') ? await response.json() : await response.text();
  if (!response.ok) {
    if (response.status === 401 && state.admin) { state.admin = null; renderLogin(); }
    throw new Error(result.error || '请求失败');
  }
  return result;
}
function toast(message, error = false) {
  document.querySelector('.toast')?.remove();
  document.body.insertAdjacentHTML('beforeend', `<div class="toast ${error ? 'toast-error' : ''}">${esc(message)}</div>`);
  setTimeout(() => document.querySelector('.toast')?.remove(), 2600);
}
function renderLogin() {
  clearInterval(state.timer);
  app.innerHTML = `<main class="login"><form class="login-card" id="login-form"><span class="mark">弈</span><span class="eyebrow">LIVEOPS CONTROL PLANE</span><h1>运营中心</h1><p class="muted">员工身份、最小权限、全程审计</p><label>员工账号<input name="username" autocomplete="username" required autofocus></label><label>密码<input name="password" type="password" autocomplete="current-password" required></label><div class="error"></div><button class="btn primary">安全登录</button></form></main>`;
}
function shell() {
  app.innerHTML = `<div class="shell"><aside class="sidebar"><div class="brand"><span class="mark">弈</span><span><strong>LiveOps</strong><small>${esc(state.admin.username)} · ${esc(state.admin.role || 'admin')}</small></span></div><nav>${groups.map(([group, items]) => `<div class="nav-group"><span>${group}</span>${items.map(([id, label]) => `<button class="nav ${id === state.view ? 'active' : ''}" data-view="${id}">${label}</button>`).join('')}</div>`).join('')}</nav><div class="sidebar-footer"><button class="btn" data-action="logout">退出会话</button></div></aside><main class="main"><header class="top"><div><span class="eyebrow">LIVE OPERATIONS</span><h1>${labels[state.view]}</h1></div><span class="muted" id="updated"></span></header><div id="content"></div></main></div>`;
}
function content(html) {
  document.querySelector('#content').innerHTML = html;
  document.querySelector('#updated').textContent = `更新于 ${new Date().toLocaleTimeString()}`;
}
function rowActions(resource, row) {
  const actions = {
    configVersions: [['publish', '发布', 'config.publish'], ['rollback', '回滚', 'config.rollback']],
    messages: [['send', '进入队列', null]], orders: [['refund', '退款', 'order.refund']],
    tickets: [['compensate', '发放补偿', 'ticket.compensate']],
    alerts: [['acknowledge', '确认', null]],
  }[resource] || [];
  return actions.map(([action, label, confirm]) => `<button class="btn ${confirm ? 'danger' : ''}" data-command="${resource}|${row.id}|${action}|${confirm || ''}">${label}</button>`).join(' ');
}
function table(rows, columns, resource = '') {
  if (!rows.length) return '<div class="panel empty">暂无记录</div>';
  const hasActions = rowActions(resource, rows[0]);
  return `<div class="table-wrap"><table><thead><tr>${columns.map(item => `<th>${esc(item)}</th>`).join('')}${hasActions ? '<th>操作</th>' : ''}</tr></thead><tbody>${rows.map(row => `<tr>${columns.map(key => `<td>${key === 'status' ? `<span class="badge ${['disabled', 'closed', 'rejected', 'firing'].includes(row[key]) ? 'off' : ''}">${esc(row[key] || '-')}</span>` : esc(row[key] ?? '-')}</td>`).join('')}${hasActions ? `<td>${rowActions(resource, row)}</td>` : ''}</tr>`).join('')}</tbody></table></div>`;
}
async function load() {
  clearInterval(state.timer);
  shell();
  try {
    if (state.view === 'dashboard') await dashboard();
    else if (state.view === 'analytics') await analytics();
    else if (state.view === 'users') await players();
    else if (state.view === 'settings') await settings();
    else if (state.view === 'rooms') { await rooms(); state.timer = setInterval(rooms, 5000); }
    else if (state.view === 'audit') await audit();
    else await resourceView(state.view);
  } catch (error) {
    content(`<div class="panel empty"><b>无法加载模块</b><p>${esc(error.message)}</p></div>`);
  }
}
async function dashboard() {
  const [{ stats, trend, games }, live] = await Promise.all([api('/api/admin/dashboard'), api('/api/admin/liveops/bootstrap')]);
  const max = Math.max(1, ...trend.map(item => item.matches));
  content(`<section class="cards">${[['玩家', stats.users], ['正常账号', stats.activeUsers], ['累计对局', stats.matches], ['在线房间', stats.onlineRooms], ['活动', live.counts.campaigns], ['告警', live.counts.alerts]].map(item => `<article class="card"><span>${item[0]}</span><b>${item[1]}</b></article>`).join('')}</section><div class="layout"><section class="panel"><h2>近 14 天对局趋势</h2><div class="bars">${trend.map(item => `<div class="bar" style="height:${Math.max(3, item.matches / max * 100)}%" data-tip="${item.date} · ${item.matches} 局"></div>`).join('')}</div></section><section class="panel"><h2>游戏表现</h2>${games.map(game => `<div class="game-stat"><b>${gameNames[game.game]}</b><span>${game.matches} 局</span><span>${game.winRate}%</span></div>`).join('')}<h2 class="section-title">第三方适配器</h2>${Object.entries(live.adapters).map(([name, adapter]) => `<div class="game-stat"><b>${name}</b><span>${adapter.mode}</span><span class="badge off">${adapter.status}</span></div>`).join('')}</section></div>`);
}
async function analytics() {
  const { funnel, retention, cohorts, gameMix } = await api('/api/admin/liveops/analytics');
  const max = Math.max(1, ...funnel.map(item => item.users));
  content(`<section class="cards">${Object.entries(retention).map(([key, item]) => `<article class="card"><span>${key.toUpperCase()} 留存</span><b>${item.rate}%</b><small class="muted">${item.users} / ${item.eligible} 人</small></article>`).join('')}${Object.entries(gameMix).map(([game, count]) => `<article class="card"><span>${gameNames[game]}对局</span><b>${count}</b></article>`).join('')}</section>
    <div class="layout"><section class="panel"><h2>玩家转化漏斗</h2><div class="funnel">${funnel.map(item => `<div><span>${esc(item.stage)}</span><i style="width:${item.users / max * 100}%"></i><b>${item.users}</b></div>`).join('')}</div></section>
    <section class="panel"><h2>注册周 Cohort</h2><div class="table-wrap"><table><thead><tr><th>注册周</th><th>用户</th><th>首局</th><th>两局+</th></tr></thead><tbody>${cohorts.map(item => `<tr><td>${item.week}</td><td>${item.users}</td><td>${item.activated}</td><td>${item.repeat}</td></tr>`).join('')}</tbody></table></div></section></div>`);
}
async function players() {
  content(`<div class="toolbar"><input id="user-q" placeholder="搜索手机号、昵称或玩家 ID"><select id="user-status"><option value="all">全部状态</option><option value="active">正常</option><option value="disabled">已禁用</option></select><button class="btn" data-export="users">导出 CSV</button></div><div id="user-list"></div><div id="drawer"></div>`);
  const query = async () => {
    const q = encodeURIComponent(document.querySelector('#user-q').value);
    const status = document.querySelector('#user-status').value;
    const { users } = await api(`/api/admin/users?q=${q}&status=${status}`);
    document.querySelector('#user-list').innerHTML = users.length ? `<div class="table-wrap"><table><thead><tr><th>玩家</th><th>手机号</th><th>注册时间</th><th>对局</th><th>状态</th><th>操作</th></tr></thead><tbody>${users.map(user => `<tr><td><button class="link" data-player="${user.id}">${esc(user.nickname)}</button><br><small class="muted">${esc(user.id)}</small></td><td>${esc(user.phone)}</td><td>${new Date(user.createdAt).toLocaleString()}</td><td>${user.matches}</td><td><span class="badge ${user.disabled ? 'off' : ''}">${user.disabled ? '已禁用' : '正常'}</span></td><td><button class="btn ${user.disabled ? '' : 'danger'}" data-toggle-user="${user.id}" data-disabled="${!user.disabled}">${user.disabled ? '解禁' : '禁用'}</button></td></tr>`).join('')}</tbody></table></div>` : '<div class="panel empty">未找到玩家</div>';
  };
  document.querySelector('#user-q').addEventListener('input', query);
  document.querySelector('#user-status').addEventListener('change', query);
  await query();
}
async function showPlayer(userId) {
  const { profile } = await api(`/api/admin/liveops/players/${encodeURIComponent(userId)}`);
  document.querySelector('#drawer').innerHTML = `<section class="panel drawer"><button class="close" data-close>×</button><span class="eyebrow">PLAYER 360</span><h2>${esc(profile.user.nickname)}</h2><div class="mini-cards">${Object.entries(profile.summary).map(([key, value]) => `<div><span>${esc(key)}</span><b>${value}</b></div>`).join('')}</div><h3>资产余额</h3><pre>${esc(JSON.stringify(profile.balances, null, 2))}</pre><h3>时间线</h3>${profile.timeline.map(item => `<div class="timeline"><span>${esc(item.type)}</span><b>${esc(item.detail)}</b><small>${new Date(item.at).toLocaleString()}</small></div>`).join('') || '<p class="muted">暂无事件</p>'}</section>`;
}
async function resourceView(resource) {
  const resources = relatedResources[resource] || [resource];
  const results = await Promise.all(resources.map(name => api(`/api/admin/liveops/${name}`)));
  const [singular] = resourceMeta[resource];
  content(`<div class="toolbar"><input id="resource-q" placeholder="搜索${singular}">${resources.map(name => `<button class="btn ${name === resource ? 'primary' : ''}" data-create="${name}">新建${resourceMeta[name][0]}</button>`).join('')}<button class="btn" data-export="${resource}">导出 CSV</button></div><div id="resource-list">${results.map(({ rows }, index) => { const name = resources[index]; return `<section class="resource-section"><h2>${resourceMeta[name][0]}</h2>${table(rows, ['id', ...resourceMeta[name].slice(1), 'createdAt'], name)}</section>`; }).join('')}</div><p class="hint">写操作会记录操作者、对象、时间与变更摘要。发布、回滚、退款、补偿、处罚和库存调整需二次确认。</p>`);
  document.querySelector('#resource-q').addEventListener('input', async event => {
    const filtered = await Promise.all(resources.map(name => api(`/api/admin/liveops/${name}?q=${encodeURIComponent(event.target.value)}`)));
    document.querySelector('#resource-list').innerHTML = filtered.map(({ rows }, index) => { const name = resources[index]; return `<section class="resource-section"><h2>${resourceMeta[name][0]}</h2>${table(rows, ['id', ...resourceMeta[name].slice(1), 'createdAt'], name)}</section>`; }).join('');
  });
}
async function createResource(resource) {
  const meta = resourceMeta[resource];
  if (resource === 'staff') {
    const wrapper = document.createElement('dialog');
    wrapper.innerHTML = `<form method="dialog" id="staff-create"><h2>新建员工</h2><label>账号<input name="username" required></label><label>初始密码<input name="password" type="password" minlength="10" required></label><label>角色<select name="role"><option>operator</option><option>support</option><option>moderator</option><option>analyst</option></select></label><div class="toolbar"><button class="btn" value="cancel">取消</button><button class="btn primary" value="ok">创建</button></div></form>`;
    document.body.append(wrapper); wrapper.showModal();
    wrapper.addEventListener('close', async () => {
      if (wrapper.returnValue === 'ok') {
        try { await api('/api/admin/liveops/staff', { method: 'POST', body: JSON.stringify(Object.fromEntries(new FormData(wrapper.querySelector('form')))) }); toast('员工已创建'); await load(); } catch (error) { toast(error.message, true); }
      }
      wrapper.remove();
    });
    return;
  }
  const fields = meta.slice(1).filter(field => field !== 'status');
  const values = {};
  for (const field of fields) {
    const value = window.prompt(`请输入 ${field}`);
    if (value === null) return;
    values[field] = value;
  }
  const confirmation = { inventoryLedger: 'inventory.adjust', compensations: 'ticket.compensate', punishments: 'punishment.issue' }[resource];
  if (confirmation && !window.confirm(`这是危险操作（${confirmation}），确认继续？`)) return;
  await api(`/api/admin/liveops/${resource}`, { method: 'POST', headers: confirmation ? { 'x-confirm-action': confirmation } : {}, body: JSON.stringify(values) });
  toast(`${meta[0]}已创建`);
  await load();
}
async function settings() {
  const { settings: value } = await api('/api/admin/settings');
  content(`<form class="settings panel" id="settings-form"><label>全站公告<textarea name="announcement" rows="4" maxlength="500">${esc(value.announcement)}</textarea></label>${Object.entries(gameNames).map(([id, label]) => `<section class="game-setting"><div><h2>${label}</h2><label class="switch"><input type="checkbox" name="${id}:enabled" ${value.games[id].enabled ? 'checked' : ''}>允许进入</label></div><label>维护提示<textarea name="${id}:maintenance" rows="3">${esc(value.games[id].maintenance)}</textarea></label></section>`).join('')}<button class="btn primary">保存配置</button></form>`);
}
async function rooms() {
  const { rooms: list } = await api('/api/admin/rooms');
  content(list.length ? `<section class="room-grid">${list.map(room => `<article class="panel room"><span class="eyebrow">${gameNames[room.game]}</span><h3>${esc(room.id)}</h3><p class="muted">${room.spectators} 人观战 · 版本 ${room.version}</p><ul>${room.players.map(player => `<li>${esc(player.nickname)}<span class="badge ${player.connected ? '' : 'off'}">${player.connected ? '在线' : '重连中'}</span></li>`).join('')}</ul></article>`).join('')}</section>` : '<div class="panel empty">当前暂无在线房间</div>');
}
async function audit() {
  const { logs } = await api('/api/admin/audit-logs');
  content(`<div class="toolbar"><button class="btn" data-export="auditLogs">导出 CSV</button></div>${table(logs, ['createdAt', 'admin', 'action', 'target', 'detail'])}`);
}

app.addEventListener('submit', async event => {
  event.preventDefault();
  try {
    if (event.target.id === 'login-form') {
      const { admin } = await api('/api/admin/auth/login', { method: 'POST', body: JSON.stringify(Object.fromEntries(new FormData(event.target))) });
      state.admin = admin; await load();
    } else if (event.target.id === 'settings-form') {
      const form = new FormData(event.target);
      const games = Object.fromEntries(Object.keys(gameNames).map(id => [id, { enabled: form.has(`${id}:enabled`), maintenance: form.get(`${id}:maintenance`) }]));
      await api('/api/admin/settings', { method: 'PATCH', body: JSON.stringify({ announcement: form.get('announcement'), games }) });
      toast('运营配置已保存');
    }
  } catch (error) {
    event.target.querySelector('.error') ? event.target.querySelector('.error').textContent = error.message : toast(error.message, true);
  }
});
app.addEventListener('click', async event => {
  try {
    const view = event.target.closest('[data-view]')?.dataset.view;
    if (view) { state.view = view; await load(); return; }
    if (event.target.closest('[data-action="logout"]')) { await api('/api/admin/auth/logout', { method: 'POST' }); state.admin = null; renderLogin(); return; }
    const create = event.target.closest('[data-create]')?.dataset.create;
    if (create) { await createResource(create); return; }
    const player = event.target.closest('[data-player]')?.dataset.player;
    if (player) { await showPlayer(player); return; }
    if (event.target.closest('[data-close]')) { document.querySelector('#drawer').innerHTML = ''; return; }
    const toggle = event.target.closest('[data-toggle-user]');
    if (toggle) {
      const disabling = toggle.dataset.disabled === 'true';
      if (disabling && !window.confirm('禁用会立即终止玩家访问，确认继续？')) return;
      await api(`/api/admin/users/${encodeURIComponent(toggle.dataset.toggleUser)}`, { method: 'PATCH', body: JSON.stringify({ disabled: disabling }) });
      toast(disabling ? '玩家已禁用' : '玩家已解禁'); await players(); return;
    }
    const exportResource = event.target.closest('[data-export]')?.dataset.export;
    if (exportResource) window.location.assign(`/api/admin/liveops/export/${exportResource}?format=csv`);
    const command = event.target.closest('[data-command]')?.dataset.command;
    if (command) {
      const [resource, id, action, confirmation] = command.split('|');
      if (confirmation && !window.confirm(`这是危险操作（${confirmation}），确认继续？`)) return;
      const payload = {};
      if (action === 'refund') { payload.amount = Number(window.prompt('退款金额')); payload.reason = window.prompt('退款原因') || ''; }
      if (action === 'compensate') { payload.items = [{ asset: window.prompt('补偿资产') || 'coin', amount: Number(window.prompt('数量')) }]; payload.reason = window.prompt('补偿原因') || ''; }
      await api(`/api/admin/liveops/${resource}/${encodeURIComponent(id)}/${action}`, { method: 'POST', headers: confirmation ? { 'x-confirm-action': confirmation } : {}, body: JSON.stringify(payload) });
      toast('操作已提交并记录审计'); await load();
    }
  } catch (error) { toast(error.message, true); }
});

(async () => {
  try { state.admin = (await api('/api/admin/auth/session')).admin; await load(); }
  catch { renderLogin(); }
})();

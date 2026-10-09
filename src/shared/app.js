const meta = {
  game: document.body.dataset.game,
  title: document.body.dataset.title,
  mark: document.body.dataset.mark,
};
const labels = { gobang: '五子棋', doudizhu: '斗地主', mahjong: '麻将' };
const state = {
  view: 'game',
  user: null,
  matches: [],
  authMode: 'password',
  notice: '',
  game: null,
  room: null,
  socket: null,
  selected: new Set(),
  reconnectTimer: null,
  autoPlay: false,
  autoVersion: -1,
  settings: null,
};

const app = document.querySelector('#app');
app.innerHTML = `
  <div class="shell">
    <aside class="rail">
      <div class="brand"><span class="brand-mark">${meta.mark}</span><span><strong>弈境</strong><small>${meta.title}独立版</small></span></div>
      <nav aria-label="主导航">
        <button class="nav-button active" data-icon="局" data-view="game">牌桌</button>
        <button class="nav-button" data-icon="我" data-view="profile">我的</button>
        <button class="nav-button" data-icon="录" data-view="history">战绩</button>
      </nav>
    </aside>
    <main class="main">
      <header class="topbar">
        <div><span class="eyebrow">INDEPENDENT GAME · 01</span><h1>${meta.title}</h1></div>
        <button class="status" data-action="auth">${state.user ? '已登录' : '游客模式'}</button>
      </header>
      <div id="platform-notice" class="platform-notice hidden" role="status"></div>
      <section id="content"></section>
    </main>
  </div>
  <div id="modal"></div>`;

const content = document.querySelector('#content');
const modal = document.querySelector('#modal');

async function request(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: { 'content-type': 'application/json', ...options.headers },
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || '请求失败');
  return result;
}
function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
}
function setNotice(message) {
  state.notice = message;
  const target = document.querySelector('.notice');
  if (target) target.textContent = message;
}
function updateIdentity() {
  document.querySelector('[data-action="auth"]').textContent = state.user ? state.user.nickname : '游客模式';
}
function render() {
  document.querySelectorAll('[data-view]').forEach((button) => button.classList.toggle('active', button.dataset.view === state.view));
  const platformNotice = document.querySelector('#platform-notice');
  if (platformNotice) {
    platformNotice.textContent = state.settings?.announcement || '';
    platformNotice.classList.toggle('hidden', !state.settings?.announcement);
  }
  if (state.view === 'game') renderGame();
  if (state.view === 'profile') renderProfile();
  if (state.view === 'history') renderHistory();
}
function sidePanel(status, hint) {
  const wins = state.matches.filter((item) => item.result === 'win' && item.game === meta.game).length;
  const total = state.matches.filter((item) => item.game === meta.game).length;
  return `
    <aside class="stack">
      <section class="panel">
        <span class="eyebrow">本局状态</span><h2>${escapeHtml(status)}</h2>
        <p class="muted">${escapeHtml(hint)}</p>
      </section>
      <section class="panel">
        <span class="eyebrow">个人数据</span>
        <div class="stat-row"><div class="stat"><b>${total}</b>对局</div><div class="stat"><b>${wins}</b>胜场</div><div class="stat"><b>${total ? Math.round(wins / total * 100) : 0}%</b>胜率</div></div>
      </section>
    </aside>`;
}

function freshGobang() {
  return { board: Array(225).fill(0), turn: 1, moves: [], ended: false, message: '黑方落子' };
}
function hasFive(board, index, player) {
  const row = Math.floor(index / 15);
  const col = index % 15;
  return [[1, 0], [0, 1], [1, 1], [1, -1]].some(([dr, dc]) => {
    let count = 1;
    for (const direction of [-1, 1]) {
      for (let step = 1; step < 5; step++) {
        const r = row + dr * step * direction;
        const c = col + dc * step * direction;
        if (r < 0 || r > 14 || c < 0 || c > 14 || board[r * 15 + c] !== player) break;
        count++;
      }
    }
    return count >= 5;
  });
}
function renderGobang() {
  if (!state.game) state.game = freshGobang();
  const game = state.game;
  const board = game.board.map((stone, index) => `
    <button class="cell" data-action="place" data-index="${index}" aria-label="${Math.floor(index / 15) + 1}行${index % 15 + 1}列">
      ${stone ? `<span class="stone ${stone === 1 ? 'black' : 'white'}"></span>` : ''}
    </button>`).join('');
  content.innerHTML = `<div class="grid"><section class="panel hero">
    <div><span class="eyebrow">LOCAL DUEL</span><h2>十五路棋盘</h2></div>
    <div class="game-stage"><div class="gobang-board">${board}</div></div>
    <div class="actions">
      <button class="button primary" data-action="new">新局</button>
      <button class="button danger" data-action="surrender" ${game.ended ? 'disabled' : ''}>认输</button>
      <button class="button" data-action="draw" ${game.ended ? 'disabled' : ''}>求和</button>
      <button class="button" data-action="replay" ${game.moves.length ? '' : 'disabled'}>复盘</button>
    </div>
  </section>${sidePanel(game.message, '双方轮流落子。求和在本地双人模式下视为双方同意。')}</div>`;
}

const ranks = ['3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A', '2'];
function freshDoudizhu() {
  const hand = Array.from({ length: 17 }, (_, index) => ({ rank: ranks[index % ranks.length], suit: ['♠', '♥', '♣', '♦'][index % 4], value: index % ranks.length }));
  return { hand: hand.sort((a, b) => a.value - b.value), selected: new Set(), ended: false, auto: false, message: '轮到你出牌' };
}
function renderDoudizhu() {
  if (!state.game) state.game = freshDoudizhu();
  const game = state.game;
  const cards = game.hand.map((card, index) => `<button class="card ${['♥', '♦'].includes(card.suit) ? 'red' : ''} ${game.selected.has(index) ? 'selected' : ''}" data-action="card" data-index="${index}"><b>${card.rank}</b><br>${card.suit}</button>`).join('');
  content.innerHTML = `<div class="grid"><section class="panel hero">
    <div><span class="eyebrow">SOLO PRACTICE</span><h2>明牌训练局</h2></div>
    <div class="game-stage"><div class="cards">${cards || '<p class="empty">手牌已出完</p>'}</div></div>
    <div class="actions">
      <button class="button primary" data-action="play" ${!game.selected.size || game.ended ? 'disabled' : ''}>出牌</button>
      <button class="button" data-action="hint" ${game.ended ? 'disabled' : ''}>提示</button>
      <button class="button" data-action="auto" ${game.ended ? 'disabled' : ''}>${game.auto ? '取消托管' : '托管'}</button>
      <button class="button" data-action="new">重新发牌</button>
    </div>
  </section>${sidePanel(game.message, game.auto ? '托管已开启，将自动选择最小牌。' : '提示会选择当前最小可出牌。')}</div>`;
}

const tileNames = ['一万', '二万', '三万', '四万', '五万', '六万', '七万', '八万', '九万', '东', '南', '西', '北', '中', '发', '白'];
function freshMahjong() {
  const tiles = Array.from({ length: 14 }, (_, index) => tileNames[(index * 5 + 3) % tileNames.length]).sort();
  return { tiles, selected: null, turns: 0, ended: false, message: '选择一张牌打出' };
}
function renderMahjong() {
  if (!state.game) state.game = freshMahjong();
  const game = state.game;
  const tiles = game.tiles.map((tile, index) => `<button class="tile ${game.selected === index ? 'selected' : ''}" data-action="tile" data-index="${index}">${tile}</button>`).join('');
  content.innerHTML = `<div class="grid"><section class="panel hero">
    <div><span class="eyebrow">HAND READING</span><h2>牌效率练习</h2></div>
    <div class="game-stage"><div class="tiles">${tiles}</div></div>
    <div class="actions">
      <button class="button primary" data-action="discard" ${game.selected === null || game.ended ? 'disabled' : ''}>打出</button>
      <button class="button" data-action="hint" ${game.ended ? 'disabled' : ''}>智能提示</button>
      <button class="button" data-action="new">重开一局</button>
    </div>
  </section>${sidePanel(game.message, '提示依据孤张优先的轻量规则，适合基础牌效率训练。')}</div>`;
}
function roomLobby() {
  return `<section class="panel hero room-lobby">
    <span class="eyebrow">ONLINE ROOM</span><h2>联网对局</h2>
    <p class="muted">创建六位房间号，或输入好友分享的房间号加入。对局由服务端权威判定并自动保存战绩。</p>
    <div class="actions"><button class="button primary" data-action="create-room">创建房间</button></div>
    <label class="field">房间号<div class="actions"><input id="room-id" maxlength="6" autocomplete="off" placeholder="例如 ABC234"><button class="button" data-action="join-room">加入</button></div></label>
    <div class="notice">${escapeHtml(state.notice)}</div>
  </section>`;
}
function roomSide(room) {
  const viewer = room.viewer?.index ? `你是 ${room.viewer.index} 号玩家` : '你正在观战';
  const seats = room.players.map(player => `<li><span class="seat-number">${player.index}</span><span class="seat-name">${escapeHtml(player.nickname || '玩家')}</span><span class="seat-state ${player.connected ? 'online' : ''}">${player.connected ? '在线' : '重连中'}</span></li>`).join('');
  return `<aside class="stack room-side"><section class="panel room-card"><span class="eyebrow">房间号码</span><h2 class="room-code">${room.id}</h2><p class="viewer">${viewer}</p><div class="actions"><button class="button" data-action="copy-room">复制邀请链接</button><button class="button danger" data-action="leave-room">离开</button></div></section><section class="panel seats-card"><div class="section-heading"><h2>玩家席位</h2><span>${room.players.length} 人</span></div><ul class="seats">${seats}</ul></section></aside>`;
}
function onlineGobang(room) {
  const game = room.state;
  const board = game.board.flatMap((row, r) => row.map((stone, c) => `<button class="cell" data-action="place-online" data-row="${r}" data-col="${c}" ${stone || game.winner ? 'disabled' : ''}>${stone ? `<span class="stone ${stone === 1 ? 'black' : 'white'}"></span>` : ''}</button>`)).join('');
  const message = game.winner === -1 ? '和棋' : game.winner ? `${game.winner}号玩家获胜` : game.undoRequest ? `${game.undoRequest.from}号申请悔棋` : game.drawRequest ? `${game.drawRequest.from}号请求和棋` : `轮到 ${game.turn} 号玩家`;
  const undo = game.undoRequest && game.undoRequest.from !== room.viewer?.index ? `<button class="button primary" data-action="answer-undo" data-accept="true">同意悔棋</button><button class="button" data-action="answer-undo" data-accept="false">拒绝</button>` : '';
  const draw = game.drawRequest && game.drawRequest.from !== room.viewer?.index ? `<button class="button primary" data-action="answer-draw" data-accept="true">同意和棋</button><button class="button" data-action="answer-draw" data-accept="false">继续对局</button>` : '';
  const liveControls = !game.winner ? '<button class="button" data-action="undo">申请悔棋</button><button class="button" data-action="request-draw">求和</button><button class="button danger" data-action="surrender-online">认输</button>' : '';
  return `<div class="grid"><section class="panel hero"><span class="eyebrow">ONLINE GOBANG</span><h2>${message}</h2><div class="game-stage"><div class="gobang-board">${board}</div></div><div class="actions">${liveControls}${undo}${draw}${game.winner ? '<button class="button primary" data-action="restart-online">下一局</button>' : ''}</div></section>${roomSide(room)}</div>`;
}
function cardHtml(card, index) {
  return `<button class="card ${['♥','♦'].includes(card.suit) ? 'red' : ''} ${state.selected.has(card.id) ? 'selected' : ''}" data-action="select-item" data-id="${card.id}"><b>${card.rank}</b><br>${card.suit}</button>`;
}
function onlineDoudizhu(room) {
  const game = room.state;
  const hand = (game.hand || []).map(cardHtml).join('');
  let controls = '';
  if (game.phase === 'bidding' && game.turn === room.viewer?.index) controls = [0,1,2,3].map(score => `<button class="button" data-action="bid" data-score="${score}">${score ? `${score}分` : '不叫'}</button>`).join('');
  if (game.phase === 'doubling' && game.doubled[room.viewer?.index] === null) controls = '<button class="button primary" data-action="double" data-enabled="true">加倍</button><button class="button" data-action="double" data-enabled="false">不加倍</button>';
  if (game.phase === 'playing' && game.turn === room.viewer?.index) controls = `<button class="button primary" data-action="play-online">出牌</button><button class="button" data-action="hint-online">提示</button><button class="button" data-action="pass-online">不出</button><button class="button" data-action="auto-online">${state.autoPlay ? '取消托管' : '托管'}</button>`;
  if (game.phase === 'finished') controls = '<button class="button primary" data-action="next-round">下一局</button>';
  return `<div class="grid"><section class="panel hero"><span class="eyebrow">ONLINE DOUDIZHU</span><h2>${{waiting:'等待三人到齐',bidding:'叫分',doubling:'加倍',playing:`${game.turn}号出牌`,finished:`${game.winner}号获胜`}[game.phase]}</h2><p class="muted">地主 ${game.landlord || '未定'} · 倍数 ${game.multiplier} · 手牌数 ${game.handCounts.join(' / ')}</p><div class="game-stage"><div class="cards">${hand || '<p class="empty">观战或等待发牌</p>'}</div></div><div class="actions">${controls}</div></section>${roomSide(room)}</div>`;
}
const tileLabel = kind => ({E:'东',S:'南',W:'西',N:'北',C:'中',F:'发',P:'白'}[kind] || `${kind.slice(1)}${{m:'万',p:'筒',s:'索'}[kind[0]]}`);
function onlineMahjong(room) {
  const game = room.state;
  const hand = (game.hand || []).map(tile => `<button class="tile ${state.selected.has(tile.id) ? 'selected' : ''}" data-action="select-item" data-id="${tile.id}">${tileLabel(tile.kind)}</button>`).join('');
  let controls = game.phase === 'playing' && game.turn === room.viewer?.index ? '<button class="button primary" data-action="discard-online">打出</button><button class="button" data-action="mahjong-hint">提示</button><button class="button" data-action="self-draw">自摸</button><button class="button" data-action="concealed-kong">暗杠</button><button class="button" data-action="added-kong">补杠</button>' : '';
  if (game.response) controls = [...game.response.options, 'pass'].map(choice => `<button class="button ${choice === 'win' ? 'primary' : ''}" data-action="respond" data-choice="${choice}">${{win:'和牌',kong:'杠',pong:'碰',chi:'吃',pass:'过'}[choice]}</button>`).join('');
  if (game.phase === 'finished') controls = '<button class="button primary" data-action="next-round">下一局</button>';
  return `<div class="grid"><section class="panel hero"><span class="eyebrow">ONLINE MAHJONG</span><h2>${game.phase === 'waiting' ? '等待四人到齐' : game.phase === 'finished' ? (game.winners.length ? `${game.winners.join('、')}号和牌` : '流局') : game.phase === 'responding' ? '等待响应' : `轮到 ${game.turn} 号`}</h2><p class="muted">牌墙 ${game.wallCount} · 手牌数 ${game.handCounts.join(' / ')}</p><div class="game-stage"><div class="tiles">${hand || '<p class="empty">观战或等待发牌</p>'}</div></div><div class="actions">${controls}</div></section>${roomSide(room)}</div>`;
}
function renderGame() {
  const gameConfig = state.settings?.games?.[meta.game];
  if (gameConfig && !gameConfig.enabled) {
    content.innerHTML = `<section class="panel"><span class="eyebrow">MAINTENANCE</span><h2>${labels[meta.game]}暂不可用</h2><p class="muted">${escapeHtml(gameConfig.maintenance || '运营维护中，请稍后再试。')}</p></section>`;
    return;
  }
  if (!state.user) {
    content.innerHTML = `<section class="panel"><span class="eyebrow">LOGIN REQUIRED</span><h2>登录后进入联网房间</h2><p class="muted">登录用于保护席位、恢复断线身份并持久化战绩。</p><button class="button primary" data-action="auth">登录 / 注册</button></section>`;
    return;
  }
  if (!state.room) {
    content.innerHTML = roomLobby();
    return;
  }
  if (meta.game === 'gobang') onlineGobang(state.room);
  if (meta.game === 'doudizhu') onlineDoudizhu(state.room);
  if (meta.game === 'mahjong') onlineMahjong(state.room);
}

function renderProfile() {
  if (!state.user) {
    content.innerHTML = `<section class="panel"><span class="eyebrow">PLAYER PROFILE</span><h2>保存你的牌桌身份</h2><p class="muted">登录后可编辑资料，并跨设备保存最近战绩。</p><button class="button primary" data-action="auth">登录 / 注册</button></section>`;
    return;
  }
  content.innerHTML = `<section class="panel">
    <span class="eyebrow">PLAYER PROFILE</span><h2>${escapeHtml(state.user.nickname)}</h2>
    <form id="profile-form">
      <label class="field">昵称<input name="nickname" maxlength="20" value="${escapeHtml(state.user.nickname)}" required></label>
      <label class="field">签名<textarea name="bio" maxlength="80" rows="3">${escapeHtml(state.user.bio || '')}</textarea></label>
      <div class="notice">${escapeHtml(state.notice)}</div>
      <div class="actions"><button class="button primary">保存资料</button><button type="button" class="button danger" data-action="logout">退出登录</button></div>
    </form>
  </section>`;
}
function renderHistory() {
  if (!state.user) {
    content.innerHTML = `<section class="panel"><h2>战绩尚未同步</h2><p class="muted">游客仍可完整游玩；登录后每局结果会写入你的账户。</p><button class="button primary" data-action="auth">立即登录</button></section>`;
    return;
  }
  const items = state.matches.map((match) => `<li><span><b>${labels[match.game]}</b><br><small class="muted">${new Date(match.createdAt).toLocaleString()}</small></span><strong class="result-${match.result}">${{ win: '胜利', loss: '负局', draw: '和局' }[match.result]}</strong></li>`).join('');
  content.innerHTML = `<section class="panel"><span class="eyebrow">MATCH ARCHIVE</span><h2>最近战绩</h2><ul class="history">${items || '<li class="empty">还没有已记录的对局</li>'}</ul></section>`;
}

function openAuth() {
  const usesCode = state.authMode === 'code' || state.authMode === 'register';
  const isRegister = state.authMode === 'register';
  modal.innerHTML = `<div class="dialog-backdrop"><section class="panel dialog">
    <div class="tabs">
      <button class="button ${state.authMode === 'password' ? 'primary' : ''}" data-auth-mode="password">密码登录</button>
      <button class="button ${state.authMode === 'code' ? 'primary' : ''}" data-auth-mode="code">验证码登录</button>
      <button class="button ${isRegister ? 'primary' : ''}" data-auth-mode="register">手机注册</button>
    </div>
    <form id="auth-form">
      <label class="field">手机号<input name="phone" inputmode="numeric" pattern="1[0-9]{10}" autocomplete="tel" required></label>
      ${usesCode ? '<label class="field">验证码<div class="actions"><input name="code" inputmode="numeric" maxlength="6" required><button type="button" class="button" data-action="sms">获取验证码</button></div></label>' : ''}
      ${state.authMode !== 'code' ? `<label class="field">密码<input name="password" type="password" minlength="8" autocomplete="${state.authMode === 'password' ? 'current-password' : 'new-password'}" required></label>` : ''}
      <div class="notice">${escapeHtml(state.notice)}</div>
      <div class="actions"><button class="button primary">${isRegister ? '创建账户' : '登录'}</button><button type="button" class="button" data-action="wechat-login">微信登录</button><button type="button" class="button" data-action="close">取消</button></div>
    </form>
  </section></div>`;
}
async function saveMatch(result, detail) {
  if (!state.user) return;
  try {
    const { match } = await request('/api/matches', { method: 'POST', body: JSON.stringify({ game: meta.game, result, detail }) });
    state.matches.unshift(match);
  } catch (error) {
    setNotice(error.message);
  }
}
function finishGame(result, message) {
  state.game.ended = true;
  state.game.message = message;
  saveMatch(result, message);
  renderGame();
}
function gameId() {
  return meta.game === 'gobang' ? 'gomoku' : meta.game;
}
function doudizhuHint(game) {
  const hand = [...(game.hand || [])].sort((a, b) => a.value - b.value);
  if (!hand.length) return [];
  const previous = game.trick?.combo;
  if (!previous) return [hand[0].id];
  const groups = new Map();
  for (const card of hand) {
    if (!groups.has(card.value)) groups.set(card.value, []);
    groups.get(card.value).push(card);
  }
  const required = { single: 1, pair: 2, triple: 3, bomb: 4 }[previous.type];
  if (required) {
    const match = [...groups.entries()].find(([value, cards]) => value > previous.main && cards.length >= required);
    if (match) return match[1].slice(0, required).map(card => card.id);
  }
  const bomb = [...groups.values()].find(cards => cards.length === 4);
  if (previous.type !== 'rocket' && previous.type !== 'bomb' && bomb) return bomb.map(card => card.id);
  const small = hand.find(card => card.rank === 'SJ');
  const big = hand.find(card => card.rank === 'BJ');
  return small && big && previous.type !== 'rocket' ? [small.id, big.id] : [];
}
function mahjongHint(hand) {
  const counts = new Map();
  for (const tile of hand || []) counts.set(tile.kind, (counts.get(tile.kind) || 0) + 1);
  return [...(hand || [])].sort((a, b) => (counts.get(a.kind) - counts.get(b.kind)))[0]?.id || null;
}
function scheduleAutoPlay() {
  const game = state.room?.state;
  if (!state.autoPlay || meta.game !== 'doudizhu' || game?.phase !== 'playing' || game.turn !== state.room.viewer?.index) return;
  if (state.autoVersion === state.room.version) return;
  state.autoVersion = state.room.version;
  setTimeout(() => {
    if (!state.autoPlay || state.room?.version !== state.autoVersion) return;
    const cards = doudizhuHint(state.room.state);
    sendAction(cards.length ? { type: 'play', cards } : { type: 'pass' });
  }, 900);
}
function connectRoom(command) {
  if (state.socket?.readyState === WebSocket.OPEN) return state.socket.send(JSON.stringify(command));
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const socket = new WebSocket(`${protocol}//${location.host}/ws`);
  state.socket = socket;
  socket.addEventListener('open', () => socket.send(JSON.stringify(command)), { once: true });
  socket.addEventListener('message', event => {
    const message = JSON.parse(event.data);
    if (message.type === 'error') return setNotice(message.message);
    if (message.type !== 'state') return;
    state.room = message.room;
    state.selected.clear();
    if (message.room.viewer?.token) localStorage.setItem(`room:${meta.game}:${message.room.id}`, message.room.viewer.token);
    history.replaceState(null, '', `?room=${message.room.id}`);
    renderGame();
    scheduleAutoPlay();
    if (message.room.state.phase === 'finished' || message.room.state.winner) setTimeout(loadMatches, 250);
  });
  socket.addEventListener('close', () => {
    if (!state.room || !state.user) return;
    clearTimeout(state.reconnectTimer);
    state.reconnectTimer = setTimeout(() => {
      const roomId = state.room.id;
      connectRoom({ type: 'join', roomId, token: localStorage.getItem(`room:${meta.game}:${roomId}`) });
    }, 1200);
  });
}
function sendAction(action) {
  if (state.socket?.readyState !== WebSocket.OPEN) return setNotice('连接已断开，正在重连');
  state.socket.send(JSON.stringify({ type: 'action', action }));
}

app.addEventListener('click', async (event) => {
  const target = event.target.closest('button');
  if (!target) return;
  if (target.dataset.view) {
    state.view = target.dataset.view;
    render();
    return;
  }
  const action = target.dataset.action;
  if (action === 'auth') return openAuth();
  if (action === 'create-room') return connectRoom({ type: 'create', gameId: gameId() });
  if (action === 'join-room') {
    const roomId = document.querySelector('#room-id')?.value.trim().toUpperCase();
    if (!roomId) return setNotice('请输入房间号');
    return connectRoom({ type: 'join', roomId, token: localStorage.getItem(`room:${meta.game}:${roomId}`) });
  }
  if (action === 'copy-room') {
    await navigator.clipboard.writeText(`${location.origin}${location.pathname}?room=${state.room.id}`);
    return;
  }
  if (action === 'leave-room') {
    clearTimeout(state.reconnectTimer);
    state.room = null;
    state.socket?.close();
    state.socket = null;
    history.replaceState(null, '', location.pathname);
    return renderGame();
  }
  if (action === 'select-item') {
    const id = target.dataset.id;
    state.selected.has(id) ? state.selected.delete(id) : state.selected.add(id);
    return renderGame();
  }
  if (action === 'place-online') return sendAction({ type:'place', row:+target.dataset.row, col:+target.dataset.col });
  if (action === 'undo') return sendAction({ type:'requestUndo' });
  if (action === 'answer-undo') return sendAction({ type:'answerUndo', accept:target.dataset.accept === 'true' });
  if (action === 'request-draw') return sendAction({ type:'requestDraw' });
  if (action === 'answer-draw') return sendAction({ type:'answerDraw', accept:target.dataset.accept === 'true' });
  if (action === 'surrender-online') return sendAction({ type:'surrender' });
  if (action === 'restart-online') return sendAction({ type:'restart' });
  if (action === 'bid') return sendAction({ type:'bid', score:+target.dataset.score });
  if (action === 'double') return sendAction({ type:'double', enabled:target.dataset.enabled === 'true' });
  if (action === 'play-online') return sendAction({ type:'play', cards:[...state.selected] });
  if (action === 'hint-online') {
    state.selected = new Set(doudizhuHint(state.room.state));
    if (!state.selected.size) return setNotice('当前没有找到可压制的基础牌型');
    return renderGame();
  }
  if (action === 'auto-online') {
    state.autoPlay = !state.autoPlay;
    state.autoVersion = -1;
    renderGame();
    return scheduleAutoPlay();
  }
  if (action === 'pass-online') return sendAction({ type:'pass' });
  if (action === 'discard-online') return sendAction({ type:'discard', tile:[...state.selected][0] });
  if (action === 'mahjong-hint') {
    const tile = mahjongHint(state.room.state.hand);
    state.selected = new Set(tile ? [tile] : []);
    return renderGame();
  }
  if (action === 'self-draw') return sendAction({ type:'selfDraw' });
  if (action === 'concealed-kong') return sendAction({ type:'concealedKong', tiles:[...state.selected] });
  if (action === 'added-kong') return sendAction({ type:'addedKong', tile:[...state.selected][0] });
  if (action === 'respond') return sendAction({ type:'respond', choice:target.dataset.choice, tiles:[...state.selected] });
  if (action === 'next-round') return sendAction({ type:'nextRound' });
  if (action === 'new') {
    state.game = null;
    renderGame();
  }
  if (meta.game === 'gobang') {
    if (action === 'place' && !state.game.ended) {
      const index = Number(target.dataset.index);
      if (state.game.board[index]) return;
      const player = state.game.turn;
      state.game.board[index] = player;
      state.game.moves.push({ index, player });
      if (hasFive(state.game.board, index, player)) return finishGame(player === 1 ? 'win' : 'loss', `${player === 1 ? '黑' : '白'}方五子连珠`);
      state.game.turn = player === 1 ? 2 : 1;
      state.game.message = `${state.game.turn === 1 ? '黑' : '白'}方落子`;
      renderGame();
    }
    if (action === 'surrender') return finishGame(state.game.turn === 1 ? 'loss' : 'win', `${state.game.turn === 1 ? '黑' : '白'}方认输`);
    if (action === 'draw') return finishGame('draw', '双方同意和棋');
    if (action === 'replay') {
      const moves = [...state.game.moves];
      state.game = freshGobang();
      state.game.ended = true;
      state.game.message = '复盘播放中';
      renderGame();
      moves.forEach((move, index) => setTimeout(() => {
        state.game.board[move.index] = move.player;
        if (index === moves.length - 1) state.game.message = '复盘完成';
        renderGame();
      }, 250 * (index + 1)));
    }
  }
  if (meta.game === 'doudizhu') {
    if (action === 'card' && !state.game.ended) {
      const index = Number(target.dataset.index);
      state.game.selected.has(index) ? state.game.selected.delete(index) : state.game.selected.add(index);
      renderGame();
    }
    if (action === 'hint') {
      state.game.selected = new Set([0]);
      state.game.message = `建议先出 ${state.game.hand[0]?.rank || ''}`;
      renderGame();
    }
    if (action === 'play') {
      state.game.hand = state.game.hand.filter((_, index) => !state.game.selected.has(index));
      state.game.selected.clear();
      if (!state.game.hand.length) return finishGame('win', '手牌已全部出完');
      state.game.message = `已出牌，还剩 ${state.game.hand.length} 张`;
      renderGame();
    }
    if (action === 'auto') {
      state.game.auto = !state.game.auto;
      if (state.game.auto) {
        state.game.selected = new Set([0]);
        state.game.message = '托管已选择最小牌';
      }
      renderGame();
    }
  }
  if (meta.game === 'mahjong') {
    if (action === 'tile') {
      state.game.selected = Number(target.dataset.index);
      renderGame();
    }
    if (action === 'hint') {
      const counts = Object.fromEntries(tileNames.map((tile) => [tile, state.game.tiles.filter((item) => item === tile).length]));
      const index = state.game.tiles.findIndex((tile) => counts[tile] === 1);
      state.game.selected = index < 0 ? state.game.tiles.length - 1 : index;
      state.game.message = `建议打出孤张：${state.game.tiles[state.game.selected]}`;
      renderGame();
    }
    if (action === 'discard') {
      const discarded = state.game.tiles.splice(state.game.selected, 1)[0];
      state.game.tiles.push(tileNames[(state.game.turns * 7 + 2) % tileNames.length]);
      state.game.tiles.sort();
      state.game.selected = null;
      state.game.turns++;
      state.game.message = `打出 ${discarded}，已摸新牌`;
      if (state.game.turns >= 8) return finishGame('win', '牌效率训练完成');
      renderGame();
    }
  }
  if (action === 'logout') {
    clearTimeout(state.reconnectTimer);
    state.room = null;
    state.socket?.close();
    state.socket = null;
    await request('/api/auth/logout', { method: 'POST' });
    state.user = null;
    state.matches = [];
    updateIdentity();
    render();
  }
});

modal.addEventListener('click', async (event) => {
  const target = event.target.closest('button');
  if (!target) return;
  if (target.dataset.authMode) {
    state.authMode = target.dataset.authMode;
    state.notice = '';
    openAuth();
  }
  if (target.dataset.action === 'close') modal.innerHTML = '';
  if (target.dataset.action === 'wechat-login') {
    try {
      location.href = (await request('/api/auth/wechat/web')).url;
    } catch (error) {
      setNotice(error.message);
    }
  }
  if (target.dataset.action === 'sms') {
    const phone = new FormData(document.querySelector('#auth-form')).get('phone');
    try {
      const result = await request('/api/auth/sms/send', { method: 'POST', body: JSON.stringify({ phone }) });
      setNotice(result.developmentCode ? `开发验证码：${result.developmentCode}` : '验证码已发送');
    } catch (error) {
      setNotice(error.message);
    }
  }
});
modal.addEventListener('submit', async (event) => {
  event.preventDefault();
  const values = Object.fromEntries(new FormData(event.target));
  try {
    const endpoint = state.authMode === 'password'
      ? '/api/auth/login'
      : state.authMode === 'code' ? '/api/auth/sms/login' : '/api/auth/register';
    const result = await request(endpoint, { method: 'POST', body: JSON.stringify(values) });
    state.user = result.user;
    state.notice = '';
    modal.innerHTML = '';
    updateIdentity();
    await loadMatches();
    render();
    const roomId = new URLSearchParams(location.search).get('room')?.toUpperCase();
    if (roomId) connectRoom({ type: 'join', roomId, token: localStorage.getItem(`room:${meta.game}:${roomId}`) });
  } catch (error) {
    setNotice(error.message);
  }
});
content.addEventListener('submit', async (event) => {
  if (event.target.id !== 'profile-form') return;
  event.preventDefault();
  const values = Object.fromEntries(new FormData(event.target));
  try {
    const result = await request('/api/me', { method: 'PATCH', body: JSON.stringify(values) });
    state.user = result.user;
    state.notice = '资料已保存';
    updateIdentity();
    renderProfile();
  } catch (error) {
    setNotice(error.message);
  }
});
async function loadMatches() {
  if (!state.user) return;
  try {
    state.matches = (await request('/api/matches')).matches;
  } catch {
    state.matches = [];
  }
}
async function initialize() {
  try {
    state.settings = (await request('/api/config')).settings;
    if (state.settings.announcement) state.notice = state.settings.announcement;
  } catch {
    state.settings = null;
  }
  try {
    state.user = (await request('/api/me')).user;
    await loadMatches();
    const roomId = new URLSearchParams(location.search).get('room')?.toUpperCase();
    if (roomId) connectRoom({ type: 'join', roomId, token: localStorage.getItem(`room:${meta.game}:${roomId}`) });
  } catch {
    state.user = null;
  }
  updateIdentity();
  render();
}
initialize();

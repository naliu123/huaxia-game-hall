const SUITS = ['m','p','s'];
const HONORS = ['E','S','W','N','C','F','P'];
const ORPHANS = new Set(['m1','m9','p1','p9','s1','s9',...HONORS]);

export const mahjong = {
  id: 'mahjong', title: '四人麻将', minPlayers: 4, maxPlayers: 4,
  initialState: emptyState,
  onPlayersChanged(state, { players }) {
    return players.filter(player => !player.expired).length === 4 && state.phase === 'waiting' ? startRound(state) : state;
  },
  reduce(state, action, context) {
    if (action.type === 'discard') return discard(state, action, context);
    if (action.type === 'respond') return respond(state, action, context);
    if (action.type === 'concealedKong') return concealedKong(state, action, context);
    if (action.type === 'addedKong') return addedKong(state, action, context);
    if (action.type === 'selfDraw') return selfDraw(state, context);
    if (action.type === 'nextRound') {
      requireFour(context.players);
      if (state.phase !== 'finished') throw new Error('本局尚未结束');
      return startRound(state);
    }
    throw new Error('未知的麻将操作');
  },
  snapshot(state, { playerIndex = 0 }) {
    const ownResponse = state.pending?.eligible.find(item => item.player === playerIndex) || null;
    return {
      phase: state.phase, round: state.round, dealer: state.dealer, turn: state.turn, wallCount: state.wall.length,
      hand: playerIndex ? state.hands[playerIndex] : null, handCounts: state.hands.slice(1).map(hand => hand.length),
      melds: state.melds, discards: state.discards, lastDiscard: state.lastDiscard,
      drawnTile: playerIndex === state.turn ? state.drawnTile : null,
      response: ownResponse ? { options: ownResponse.options, tile: state.pending.tile, kind: state.pending.kind } : null,
      waitingResponses: state.pending?.eligible.filter(item => !state.pending.responses[item.player]).map(item => item.player) || [],
      winners: state.winners, winType: state.winType, winningTile: state.winningTile, roundResult: state.roundResult, stats: state.stats
    };
  }
};

function emptyState() {
  return {
    phase:'waiting', round:0, dealer:0, turn:0, wall:[], hands:[[],[],[],[],[]], melds:[[],[],[],[],[]],
    discards:[[],[],[],[],[]], lastDiscard:null, drawnTile:null, pending:null, winners:[], winType:null,
    winningTile:null, roundResult:null, stats:[null,{wins:0},{wins:0},{wins:0},{wins:0}]
  };
}

export function createMahjongDeck() {
  const kinds = [...SUITS.flatMap(suit => Array.from({length:9}, (_,i) => `${suit}${i+1}`)), ...HONORS];
  return kinds.flatMap(kind => Array.from({length:4}, (_,copy) => ({ id:`${kind}-${copy}`, kind })));
}

export function startRound(previous, random = Math.random) {
  const deck = createMahjongDeck();
  for (let i=deck.length-1; i>0; i--) {
    const j = Math.floor(random()*(i+1));
    [deck[i],deck[j]] = [deck[j],deck[i]];
  }
  const round = previous.round + 1;
  const dealer = previous.dealer ? previous.dealer % 4 + 1 : 1;
  const hands = [[],[],[],[],[]];
  let cursor = 0;
  for (let count=0; count<13; count++) for (let player=1; player<=4; player++) hands[player].push(deck[cursor++]);
  hands[dealer].push(deck[cursor++]);
  const drawnTile = hands[dealer].at(-1).id;
  hands.slice(1).forEach(sortTiles);
  return { ...emptyState(), phase:'playing', round, dealer, turn:dealer, wall:deck.slice(cursor), hands, drawnTile, stats:structuredClone(previous.stats) };
}

function discard(state, action, { playerIndex }) {
  requireTurn(state, playerIndex);
  const tile = state.hands[playerIndex].find(item => item.id === action.tile);
  if (!tile) throw new Error('这张牌不在你的手牌中');
  const next = structuredClone(state);
  removeIds(next.hands[playerIndex], [tile.id]);
  next.discards[playerIndex].push(tile);
  next.lastDiscard = { player:playerIndex, tile };
  next.drawnTile = null;
  const eligible = responseOptions(next, playerIndex, tile);
  if (eligible.length) {
    next.phase = 'responding'; next.turn = 0;
    next.pending = { kind:'discard', from:playerIndex, tile, eligible, responses:{} };
  } else advanceAndDraw(next, playerIndex % 4 + 1);
  return next;
}

function responseOptions(state, from, tile, onlyWin = false) {
  const eligible = [];
  for (let distance=1; distance<=3; distance++) {
    const player = (from - 1 + distance) % 4 + 1;
    const hand = state.hands[player];
    const same = hand.filter(item => item.kind === tile.kind).length;
    const options = [];
    if (canWin([...hand,tile], state.melds[player].length)) options.push('win');
    if (!onlyWin) {
      if (same >= 3) options.push('kong');
      if (same >= 2) options.push('pong');
      if (distance === 1 && chiChoices(hand, tile.kind).length) options.push('chi');
    }
    if (options.length) eligible.push({ player, distance, options });
  }
  return eligible;
}

function respond(state, action, { playerIndex }) {
  if (state.phase !== 'responding' || !state.pending) throw new Error('当前没有待响应的牌');
  const entry = state.pending.eligible.find(item => item.player === playerIndex);
  if (!entry) throw new Error('你无需响应');
  if (state.pending.responses[playerIndex]) throw new Error('你已经响应过了');
  const choice = action.choice || 'pass';
  if (choice !== 'pass' && !entry.options.includes(choice)) throw new Error('该响应不可用');
  validateResponseTiles(state, action, playerIndex, choice);
  const next = structuredClone(state);
  next.pending.responses[playerIndex] = { choice, tiles:action.tiles || [] };
  if (next.pending.eligible.every(item => next.pending.responses[item.player])) resolveResponses(next);
  return next;
}

function validateResponseTiles(state, action, player, choice) {
  if (!['chi','pong','kong'].includes(choice)) return;
  const count = choice === 'kong' ? 3 : 2;
  if (!Array.isArray(action.tiles) || action.tiles.length !== count || new Set(action.tiles).size !== count) throw new Error('请选择正确数量的手牌');
  const chosen = action.tiles.map(id => state.hands[player].find(tile => tile.id === id));
  if (chosen.some(tile => !tile)) throw new Error('响应牌不在你的手牌中');
  if (choice === 'chi') {
    if (!isChi(chosen.map(tile => tile.kind), state.pending.tile.kind)) throw new Error('所选牌不能组成顺子');
  } else if (chosen.some(tile => tile.kind !== state.pending.tile.kind)) throw new Error('所选牌与目标牌不同');
}

function resolveResponses(state) {
  const chosen = state.pending.eligible.map(entry => ({...entry,...state.pending.responses[entry.player]})).filter(item => item.choice !== 'pass');
  const wins = chosen.filter(item => item.choice === 'win');
  if (wins.length) return finish(state, wins.map(item => item.player), state.pending.kind === 'addedKong' ? 'rob-kong' : 'discard', state.pending.tile, state.pending.from);
  const priority = { kong:2, pong:2, chi:1 };
  chosen.sort((a,b) => priority[b.choice]-priority[a.choice] || a.distance-b.distance);
  const winner = chosen[0];
  if (!winner) {
    const pending = state.pending;
    state.pending = null; state.phase = 'playing';
    return pending.kind === 'addedKong' ? completeAddedKong(state,pending.from,pending.tile) : advanceAndDraw(state,pending.from%4+1);
  }
  const pending = state.pending;
  const claimed = winner.tiles.map(id => state.hands[winner.player].find(tile => tile.id === id));
  removeIds(state.hands[winner.player], winner.tiles);
  if (pending.kind === 'discard') state.discards[pending.from].pop();
  state.melds[winner.player].push({ type:winner.choice, tiles:[...claimed,pending.tile], from:pending.from, open:true });
  state.pending = null; state.phase = 'playing'; state.turn = winner.player; state.lastDiscard = null;
  if (winner.choice === 'kong') drawSupplement(state,winner.player);
}

function concealedKong(state, action, { playerIndex }) {
  requireTurn(state,playerIndex); requireDrawnTile(state,playerIndex);
  const tiles = selectedTiles(state.hands[playerIndex],action.tiles,4);
  if (new Set(tiles.map(tile => tile.kind)).size !== 1) throw new Error('暗杠必须是四张相同的牌');
  const next = structuredClone(state);
  removeIds(next.hands[playerIndex],action.tiles);
  next.melds[playerIndex].push({type:'kong',tiles,from:playerIndex,open:false});
  drawSupplement(next,playerIndex);
  return next;
}

function addedKong(state, action, { playerIndex }) {
  requireTurn(state,playerIndex); requireDrawnTile(state,playerIndex);
  const tile = state.hands[playerIndex].find(item => item.id === action.tile);
  if (!tile) throw new Error('这张牌不在你的手牌中');
  if (!state.melds[playerIndex].some(item => item.type === 'pong' && item.tiles[0].kind === tile.kind)) throw new Error('没有可补杠的碰牌');
  const next = structuredClone(state);
  const eligible = responseOptions(next,playerIndex,tile,true);
  if (eligible.length) {
    next.phase='responding'; next.turn=0; next.pending={kind:'addedKong',from:playerIndex,tile,eligible,responses:{}};
  } else completeAddedKong(next,playerIndex,tile);
  return next;
}

function completeAddedKong(state,player,tile) {
  removeIds(state.hands[player],[tile.id]);
  const meld = state.melds[player].find(item => item.type === 'pong' && item.tiles[0].kind === tile.kind);
  meld.type='kong'; meld.tiles.push(tile); meld.added=true;
  drawSupplement(state,player);
}
function selfDraw(state,{playerIndex}) {
  requireTurn(state,playerIndex); requireDrawnTile(state,playerIndex);
  if (!canWin(state.hands[playerIndex],state.melds[playerIndex].length)) throw new Error('当前手牌不能和牌');
  const next=structuredClone(state);
  finish(next,[playerIndex],'self-draw',next.hands[playerIndex].find(tile => tile.id === next.drawnTile));
  return next;
}
function drawSupplement(state,player) {
  if (!state.wall.length) return finishDraw(state);
  const tile=state.wall.pop(); state.hands[player].push(tile); sortTiles(state.hands[player]);
  Object.assign(state,{turn:player,drawnTile:tile.id,phase:'playing'});
}
function advanceAndDraw(state,player) {
  if (!state.wall.length) return finishDraw(state);
  const tile=state.wall.pop(); state.hands[player].push(tile); sortTiles(state.hands[player]);
  Object.assign(state,{turn:player,drawnTile:tile.id,phase:'playing',pending:null});
}
function finish(state,winners,winType,tile,source=0) {
  Object.assign(state,{phase:'finished',turn:0,pending:null,winners,winType,winningTile:tile});
  winners.forEach(player => state.stats[player].wins++);
  state.roundResult={winners,from:winType==='self-draw'?0:source||state.lastDiscard?.player||0,type:winType};
}
function finishDraw(state) {
  Object.assign(state,{phase:'finished',turn:0,pending:null,winners:[],winType:'draw',roundResult:{winners:[],from:0,type:'draw'}});
  return state;
}

export function canWin(tiles, meldCount=0) {
  const kinds=tiles.map(tile => typeof tile === 'string' ? tile : tile.kind);
  if (!meldCount && kinds.length===14 && (isThirteenOrphans(kinds)||isSevenPairs(kinds))) return true;
  const needed=4-meldCount;
  if (kinds.length!==needed*3+2) return false;
  const counts=countKinds(kinds);
  for (const [kind,count] of counts) if (count>=2) {
    counts.set(kind,count-2);
    if (canFormSets(counts,needed)) return true;
    counts.set(kind,count);
  }
  return false;
}
function canFormSets(counts,remaining) {
  if (!remaining) return [...counts.values()].every(count => count===0);
  const kind=[...counts.keys()].find(key => counts.get(key)>0);
  if (!kind) return false;
  if (counts.get(kind)>=3) {
    counts.set(kind,counts.get(kind)-3);
    if (canFormSets(counts,remaining-1)) return true;
    counts.set(kind,counts.get(kind)+3);
  }
  const match=/^([mps])([1-7])$/.exec(kind);
  if (match) {
    const a=`${match[1]}${+match[2]+1}`, b=`${match[1]}${+match[2]+2}`;
    if ((counts.get(a)||0)&&(counts.get(b)||0)) {
      counts.set(kind,counts.get(kind)-1); counts.set(a,counts.get(a)-1); counts.set(b,counts.get(b)-1);
      if (canFormSets(counts,remaining-1)) return true;
      counts.set(kind,counts.get(kind)+1); counts.set(a,counts.get(a)+1); counts.set(b,counts.get(b)+1);
    }
  }
  return false;
}
function isSevenPairs(kinds) { return [...countKinds(kinds).values()].every(count => count===2||count===4); }
function isThirteenOrphans(kinds) {
  const counts=countKinds(kinds);
  return [...ORPHANS].every(kind => counts.has(kind)) && [...counts].some(([kind,count]) => ORPHANS.has(kind)&&count===2);
}
export function chiChoices(hand,target) {
  const match=/^([mps])([1-9])$/.exec(target);
  if (!match) return [];
  const suit=match[1], value=+match[2], byKind=new Map();
  hand.forEach(tile => { if (!byKind.has(tile.kind)) byKind.set(tile.kind,tile); });
  return [[value-2,value-1],[value-1,value+1],[value+1,value+2]]
    .filter(values => values.every(number => number>=1&&number<=9&&byKind.has(`${suit}${number}`)))
    .map(values => values.map(number => byKind.get(`${suit}${number}`).id));
}
function isChi(kinds,target) {
  const parsed=[...kinds,target].sort().map(kind => /^([mps])([1-9])$/.exec(kind));
  return parsed.every(Boolean)&&new Set(parsed.map(item=>item[1])).size===1&&+parsed[1][2]===+parsed[0][2]+1&&+parsed[2][2]===+parsed[1][2]+1;
}
function selectedTiles(hand,ids,count) {
  if (!Array.isArray(ids)||ids.length!==count||new Set(ids).size!==count) throw new Error(`请选择 ${count} 张牌`);
  const tiles=ids.map(id => hand.find(tile => tile.id===id));
  if (tiles.some(tile=>!tile)) throw new Error('所选牌不在你的手牌中');
  return tiles;
}
function removeIds(hand,ids) { const selected=new Set(ids); for(let i=hand.length-1;i>=0;i--) if(selected.has(hand[i].id)) hand.splice(i,1); }
function countKinds(kinds) { const counts=new Map(); kinds.forEach(kind=>counts.set(kind,(counts.get(kind)||0)+1)); return counts; }
function sortTiles(tiles) {
  const order=kind => SUITS.includes(kind[0]) ? SUITS.indexOf(kind[0])*9 + +kind.slice(1) : 27+HONORS.indexOf(kind);
  tiles.sort((a,b)=>order(a.kind)-order(b.kind)||a.id.localeCompare(b.id));
}
function requireTurn(state,player) { if(state.phase!=='playing') throw new Error('当前不能进行该操作'); if(state.turn!==player) throw new Error('还没轮到你'); }
function requireDrawnTile(state,player) { if(!state.drawnTile||!state.hands[player].some(tile=>tile.id===state.drawnTile)) throw new Error('只有摸牌后才能进行该操作'); }
function requireFour(players) { if(players.filter(player=>!player.expired).length<4) throw new Error('请等待四位玩家到齐'); }

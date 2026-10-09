const RANKS = ['3','4','5','6','7','8','9','10','J','Q','K','A','2'];
const SUITS = ['♠','♥','♣','♦'];
const VALUE = Object.fromEntries(RANKS.map((rank, index) => [rank, index + 3]));
Object.assign(VALUE, { SJ: 16, BJ: 17 });

export const doudizhu = {
  id: 'doudizhu', title: '欢乐斗地主', minPlayers: 3, maxPlayers: 3,
  initialState: emptyState,
  onPlayersChanged(state, { players }) {
    return players.filter(player => !player.expired).length === 3 && state.phase === 'waiting' ? dealRound(state) : state;
  },
  reduce(state, action, context) {
    if (action.type === 'bid') return bid(state, action, context);
    if (action.type === 'double') return doubleStake(state, action, context);
    if (action.type === 'play') return play(state, action, context);
    if (action.type === 'pass') return pass(state, context);
    if (action.type === 'nextRound') {
      requireThree(context.players);
      if (state.phase !== 'finished') throw new Error('本局尚未结束');
      return dealRound(state);
    }
    throw new Error('未知的游戏操作');
  },
  snapshot(state, { playerIndex = 0 }) {
    return {
      phase: state.phase, round: state.round, turn: state.turn, dealer: state.dealer, landlord: state.landlord,
      bids: state.bids, highestBid: state.highestBid, doubled: state.doubled, multiplier: state.multiplier,
      bottom: state.phase === 'bidding' ? [] : state.bottom,
      hand: playerIndex ? state.hands[playerIndex] : null,
      handCounts: state.hands.slice(1).map(hand => hand.length), trick: state.trick,
      history: state.history.slice(-12), passes: state.passes, winner: state.winner, spring: state.spring,
      roundDelta: state.roundDelta, scores: state.scores, playCounts: state.playCounts
    };
  }
};

function emptyState() {
  return {
    phase: 'waiting', round: 0, turn: 0, dealer: 0, landlord: 0,
    hands: [[],[],[],[]], bottom: [], bids: [null,null,null,null], highestBid: 0, highestBidder: 0, bidTurns: 0,
    doubled: [null,null,null,null], multiplier: 1, trick: null, history: [], passes: 0, winner: 0, spring: null,
    roundDelta: [0,0,0,0], scores: [0,0,0,0], playCounts: [0,0,0,0]
  };
}

export function createDeck() {
  const deck = RANKS.flatMap(rank => SUITS.map(suit => ({ id: `${rank}-${suit}`, rank, suit, value: VALUE[rank] })));
  return [...deck, { id: 'SJ', rank: 'SJ', suit: '', value: 16 }, { id: 'BJ', rank: 'BJ', suit: '', value: 17 }];
}

export function dealRound(previous, random = Math.random) {
  const deck = createDeck();
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  const round = previous.round + 1;
  const hands = [[], deck.slice(0,17), deck.slice(17,34), deck.slice(34,51)];
  hands.slice(1).forEach(sortCards);
  const dealer = (round - 1) % 3 + 1;
  return { ...emptyState(), phase: 'bidding', round, dealer, turn: dealer, hands, bottom: deck.slice(51), scores: [...previous.scores] };
}

function bid(state, action, { playerIndex, players }) {
  requireThree(players);
  if (state.phase !== 'bidding') throw new Error('当前不是叫分阶段');
  if (state.turn !== playerIndex) throw new Error('还没轮到你叫分');
  const score = Number(action.score);
  if (![0,1,2,3].includes(score)) throw new Error('叫分必须为 0、1、2 或 3');
  if (score && score <= state.highestBid) throw new Error('叫分必须高于当前分数');
  const next = structuredClone(state);
  next.bids[playerIndex] = score;
  next.bidTurns++;
  if (score > next.highestBid) [next.highestBid, next.highestBidder] = [score, playerIndex];
  if (score === 3 || next.bidTurns === 3) {
    if (!next.highestBidder) return dealRound(state);
    next.landlord = next.highestBidder;
    next.hands[next.landlord].push(...next.bottom);
    sortCards(next.hands[next.landlord]);
    next.multiplier = next.highestBid;
    next.phase = 'doubling';
    next.turn = 0;
  } else next.turn = next.turn % 3 + 1;
  return next;
}

function doubleStake(state, action, { playerIndex }) {
  if (state.phase !== 'doubling') throw new Error('当前不是加倍阶段');
  if (state.doubled[playerIndex] !== null) throw new Error('你已经选择过是否加倍');
  if (typeof action.enabled !== 'boolean') throw new Error('加倍选项无效');
  const next = structuredClone(state);
  next.doubled[playerIndex] = action.enabled;
  if (action.enabled) next.multiplier *= 2;
  if (next.doubled.slice(1).every(value => value !== null)) {
    next.phase = 'playing';
    next.turn = next.landlord;
  }
  return next;
}

function play(state, action, { playerIndex }) {
  if (state.phase !== 'playing') throw new Error('当前不能出牌');
  if (state.turn !== playerIndex) throw new Error('还没轮到你');
  if (!Array.isArray(action.cards) || !action.cards.length || new Set(action.cards).size !== action.cards.length) throw new Error('请选择要出的牌');
  const cards = action.cards.map(id => state.hands[playerIndex].find(card => card.id === id));
  if (cards.some(card => !card)) throw new Error('出牌中包含不属于你的牌');
  const combo = classify(cards);
  if (!combo) throw new Error('牌型不合法');
  if (state.trick && state.trick.player !== playerIndex && !canBeat(combo, state.trick.combo)) throw new Error('所选牌无法压过上一手');
  const next = structuredClone(state);
  const chosen = new Set(action.cards);
  next.hands[playerIndex] = next.hands[playerIndex].filter(card => !chosen.has(card.id));
  next.trick = { player: playerIndex, cards, combo };
  next.history.push({ type: 'play', player: playerIndex, cards, combo });
  next.playCounts[playerIndex]++;
  next.passes = 0;
  if (['bomb','rocket'].includes(combo.type)) next.multiplier *= 2;
  if (!next.hands[playerIndex].length) return finish(next, playerIndex);
  next.turn = playerIndex % 3 + 1;
  return next;
}

function pass(state, { playerIndex }) {
  if (state.phase !== 'playing') throw new Error('当前不能不出');
  if (state.turn !== playerIndex) throw new Error('还没轮到你');
  if (!state.trick || state.trick.player === playerIndex) throw new Error('你是本轮首家，必须出牌');
  const next = structuredClone(state);
  next.history.push({ type: 'pass', player: playerIndex });
  if (++next.passes === 2) {
    next.turn = next.trick.player;
    next.trick = null;
    next.passes = 0;
  } else next.turn = playerIndex % 3 + 1;
  return next;
}

function finish(state, winner) {
  Object.assign(state, { phase: 'finished', winner, turn: 0 });
  const landlordWon = winner === state.landlord;
  const farmers = [1,2,3].filter(index => index !== state.landlord);
  if (landlordWon && farmers.every(index => state.playCounts[index] === 0)) {
    state.spring = 'spring'; state.multiplier *= 2;
  } else if (!landlordWon && state.playCounts[state.landlord] === 1) {
    state.spring = 'anti-spring'; state.multiplier *= 2;
  }
  for (const index of [1,2,3]) {
    const delta = index === state.landlord ? (landlordWon ? state.multiplier * 2 : -state.multiplier * 2) : (landlordWon ? -state.multiplier : state.multiplier);
    state.roundDelta[index] = delta;
    state.scores[index] += delta;
  }
  return state;
}

export function classify(cards) {
  if (!Array.isArray(cards) || !cards.length) return null;
  const values = cards.map(card => card.value ?? VALUE[card.rank]).sort((a,b) => a-b);
  const counts = new Map();
  values.forEach(value => counts.set(value, (counts.get(value) || 0) + 1));
  const groups = [...counts].sort((a,b) => a[0]-b[0]);
  const by = count => groups.filter(([,size]) => size === count).map(([value]) => value);
  const consecutive = list => list.every((value,index) => !index || value === list[index-1] + 1) && list.at(-1) < 15;
  const result = (type, main) => ({ type, main, length: cards.length });
  if (cards.length === 2 && values[0] === 16 && values[1] === 17) return result('rocket', 17);
  if (cards.length === 1) return result('single', values[0]);
  if (cards.length === 2 && groups.length === 1) return result('pair', values[0]);
  if (cards.length === 3 && groups.length === 1) return result('triple', values[0]);
  if (cards.length === 4 && groups.length === 1) return result('bomb', values[0]);
  if (cards.length === 4 && by(3).length === 1) return result('triple-single', by(3)[0]);
  if (cards.length === 5 && by(3).length === 1 && by(2).length === 1) return result('triple-pair', by(3)[0]);
  if (cards.length >= 5 && groups.length === cards.length && consecutive(values)) return result('straight', values.at(-1));
  if (cards.length >= 6 && cards.length % 2 === 0 && groups.every(([,n]) => n === 2) && consecutive(groups.map(([v]) => v))) return result('pair-straight', groups.at(-1)[0]);
  if (cards.length === 6 && by(4).length === 1) return result('four-two-single', by(4)[0]);
  if (cards.length === 8 && by(4).length === 1 && by(2).length === 2) return result('four-two-pair', by(4)[0]);
  const triples = groups.filter(([v,n]) => n >= 3 && v < 15).map(([v]) => v);
  for (let start=0; start<triples.length; start++) for (let end=start+1; end<triples.length; end++) {
    const chain = triples.slice(start,end+1);
    if (!consecutive(chain)) continue;
    const n = chain.length;
    const remaining = groups.flatMap(([v,size]) => Array(size - (chain.includes(v) ? 3 : 0)).fill(v));
    if (!remaining.length && cards.length === n*3) return result('airplane', chain.at(-1));
    if (remaining.some(v => chain.includes(v))) continue;
    if (remaining.length === n && cards.length === n*4) return result('airplane-single', chain.at(-1));
    const wings = new Map(remaining.map(v => [v, remaining.filter(x => x === v).length]));
    if (remaining.length === n*2 && wings.size === n && [...wings.values()].every(size => size === 2)) return result('airplane-pair', chain.at(-1));
  }
  return null;
}

export function canBeat(candidate, previous) {
  if (!candidate || !previous) return false;
  if (candidate.type === 'rocket') return previous.type !== 'rocket';
  if (previous.type === 'rocket') return false;
  if (candidate.type === 'bomb' && previous.type !== 'bomb') return true;
  return candidate.type === previous.type && candidate.length === previous.length && candidate.main > previous.main;
}
function sortCards(cards) { cards.sort((a,b) => a.value-b.value || a.suit.localeCompare(b.suit)); }
function requireThree(players) { if (players.filter(player => !player.expired).length < 3) throw new Error('请等待三位玩家到齐'); }

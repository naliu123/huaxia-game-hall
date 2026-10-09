import crypto from 'node:crypto';

const ROOM_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export class RoomManager {
  constructor({ games, reconnectWindowMs = 5 * 60_000, onFinished = null, onChanged = null }) {
    this.games = new Map(games.map(game => [game.id, game]));
    this.rooms = new Map();
    this.reconnectWindowMs = reconnectWindowMs;
    this.onFinished = onFinished;
    this.onChanged = onChanged;
  }

  create(gameId = 'gomoku') {
    const game = this.games.get(gameId);
    if (!game) throw new Error('不支持该游戏');
    let id;
    do id = Array.from({ length: 6 }, () => ROOM_CHARS[crypto.randomInt(ROOM_CHARS.length)]).join('');
    while (this.rooms.has(id));
    const room = { id, gameId, game, state: game.initialState(), players: [], spectators: new Set(), version: 0, createdAt: Date.now(), recordedRound: 0 };
    this.rooms.set(id, room);
    this.#changed(room);
    return room;
  }

  get(id) {
    return this.rooms.get(String(id || '').toUpperCase());
  }

  join(roomId, socket, token, identity = null) {
    const room = this.get(roomId);
    if (!room) throw new Error('房间不存在');
    let player = token && room.players.find(item => item.token === token && !item.expired);
    if (player) {
      if (identity?.id && player.userId && identity.id !== player.userId) throw new Error('重连身份不匹配');
      clearTimeout(player.cleanupTimer);
      if (player.socket && player.socket !== socket) player.socket.close(4001, '已在其他页面重连');
      Object.assign(player, { socket, connected: true, expiresAt: null });
    } else if (identity?.id && room.players.some(item => item.userId === identity.id && !item.expired)) {
      throw new Error('同一账号已在该房间入座');
    } else if (room.players.length < room.game.maxPlayers || room.players.some(item => item.expired)) {
      const openSeat = room.players.find(item => item.expired);
      player = {
        index: openSeat?.index ?? room.players.length + 1,
        token: crypto.randomUUID(),
        userId: identity?.id || null,
        nickname: identity?.nickname || `玩家${openSeat?.index ?? room.players.length + 1}`,
        socket,
        connected: true,
        cleanupTimer: null,
        expiresAt: null,
        expired: false
      };
      if (openSeat) room.players[room.players.indexOf(openSeat)] = player;
      else room.players.push(player);
    } else {
      room.spectators.add(socket);
    }
    socket.roomId = room.id;
    socket.playerIndex = player?.index ?? 0;
    socket.playerToken = player?.token ?? null;
    if (player && room.game.onPlayersChanged) {
      const nextState = room.game.onPlayersChanged(room.state, { players: room.players });
      if (nextState !== room.state) {
        room.state = nextState;
        room.version++;
      }
    }
    this.#changed(room);
    return { room, player };
  }

  leave(socket) {
    const room = this.get(socket.roomId);
    if (!room) return;
    if (!socket.playerIndex) {
      room.spectators.delete(socket);
      this.#changed(room);
      return;
    }
    const player = room.players.find(item => item.index === socket.playerIndex);
    if (!player || player.socket !== socket) return;
    Object.assign(player, { connected: false, socket: null, expiresAt: Date.now() + this.reconnectWindowMs });
    player.cleanupTimer = setTimeout(() => {
      Object.assign(player, { cleanupTimer: null, expired: true, token: null, expiresAt: null });
      this.broadcast(room);
      this.#changed(room);
    }, this.reconnectWindowMs);
    player.cleanupTimer.unref?.();
    this.broadcast(room);
    this.#changed(room);
  }

  act(socket, action) {
    const room = this.get(socket.roomId);
    if (!room) throw new Error('尚未加入房间');
    if (!socket.playerIndex) throw new Error('观战者不能操作');
    const before = room.state;
    room.state = room.game.reduce(room.state, action, { playerIndex: socket.playerIndex, players: room.players });
    room.version++;
    this.broadcast(room);
    this.#changed(room);
    const result = finishedResult(room.gameId, before, room.state);
    if (result) {
      room.recordedRound++;
      Promise.resolve(this.onFinished?.(room, { ...result, completedGame: room.recordedRound })).catch(() => {});
    }
    return room;
  }

  snapshot(room, viewer = null) {
    const playerIndex = viewer?.playerIndex || 0;
    const state = room.game.snapshot ? room.game.snapshot(room.state, { playerIndex }) : room.state;
    return {
      type: 'state',
      room: {
        id: room.id, gameId: room.gameId, gameTitle: room.game.title, version: room.version, state,
        players: room.players.map(({ index, connected, expiresAt, expired, nickname }) => ({ index, connected, reconnecting: !connected && !expired, expiresAt, nickname })),
        viewer: viewer ? { index: viewer.playerIndex, token: viewer.playerToken } : null
      }
    };
  }

  broadcast(room) {
    const sockets = [...room.players.map(player => player.socket).filter(Boolean), ...room.spectators];
    for (const socket of sockets) if (socket.readyState === 1) socket.send(JSON.stringify(this.snapshot(room, socket)));
  }

  #changed(room) {
    Promise.resolve(this.onChanged?.(room)).catch(() => {});
  }
}

function finishedResult(gameId, before, state) {
  if (gameId === 'gomoku' && !before.winner && state.winner) return { round: state.moves.length, winners: state.winner > 0 ? [state.winner] : [], draw: state.winner === -1 };
  if (gameId === 'doudizhu' && before.phase !== 'finished' && state.phase === 'finished') return { round: state.round, winners: [state.winner], detail: `第${state.round}局 · 倍数${state.multiplier}` };
  if (gameId === 'mahjong' && before.phase !== 'finished' && state.phase === 'finished') return { round: state.round, winners: state.winners, draw: state.winType === 'draw', detail: `第${state.round}局 · ${state.winType}` };
  return null;
}

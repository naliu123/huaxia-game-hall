export class RealtimeServer {
  constructor({ webSocketServer, rooms, logger = console, gameId = null, authorize = null }) {
    this.wss = webSocketServer;
    this.rooms = rooms;
    this.logger = logger;
    this.gameId = gameId;
    this.authorize = authorize;
  }
  start() {
    this.wss.on('connection', (socket, request) => {
      socket.isAlive = true;
      socket.identity = request.user || null;
      socket.on('pong', () => { socket.isAlive = true; });
      socket.on('message', data => this.#onMessage(socket, data));
      socket.on('close', () => this.rooms.leave(socket));
      socket.on('error', error => this.logger.warn?.('WebSocket error:', error.message));
      this.#send(socket, { type: 'ready' });
    });
    this.heartbeat = setInterval(() => {
      for (const socket of this.wss.clients) {
        if (!socket.isAlive) socket.terminate();
        else {
          socket.isAlive = false;
          socket.ping();
        }
      }
    }, 30_000);
    this.heartbeat.unref?.();
    return this;
  }
  stop() {
    clearInterval(this.heartbeat);
  }
  async #onMessage(socket, raw) {
    try {
      if (raw.length > 16_384) throw protocolError('消息过大', 'MESSAGE_TOO_LARGE');
      const message = JSON.parse(raw.toString());
      if (!message || typeof message !== 'object' || Array.isArray(message)) throw protocolError('消息格式无效', 'BAD_MESSAGE');
      await this.authorize?.(socket, message);
      this.#dispatch(socket, message);
    } catch (error) {
      this.#send(socket, { type: 'error', code: error.code || (error instanceof SyntaxError ? 'BAD_JSON' : 'INVALID_ACTION'), message: error instanceof SyntaxError ? '无法解析消息' : error.message });
    }
  }
  #dispatch(socket, message) {
    switch (message.type) {
      case 'create': {
        this.rooms.leave(socket);
        const gameId = message.gameId || this.gameId || 'gomoku';
        if (this.gameId && gameId !== this.gameId) throw protocolError('当前独立应用不支持该游戏', 'WRONG_GAME');
        const room = this.rooms.create(gameId);
        this.rooms.join(room.id, socket, null, socket.identity);
        this.#send(socket, this.rooms.snapshot(room, socket));
        return;
      }
      case 'join': {
        if (typeof message.roomId !== 'string') throw protocolError('请提供房间号', 'BAD_ROOM_ID');
        this.rooms.leave(socket);
        const room = this.rooms.get(message.roomId.trim());
        if (this.gameId && room?.gameId !== this.gameId) throw protocolError('房间不属于当前游戏', 'WRONG_GAME');
        const joined = this.rooms.join(message.roomId.trim(), socket, message.token, socket.identity);
        this.rooms.broadcast(joined.room);
        return;
      }
      case 'action':
        if (!message.action || typeof message.action.type !== 'string') throw protocolError('游戏操作格式无效', 'BAD_ACTION');
        this.rooms.act(socket, message.action);
        return;
      case 'ping':
        this.#send(socket, { type: 'pong', now: Date.now() });
        return;
      default:
        throw protocolError('未知消息类型', 'UNKNOWN_MESSAGE');
    }
  }
  #send(socket, data) {
    if (socket.readyState === 1) socket.send(JSON.stringify(data));
  }
}

function protocolError(message, code) {
  return Object.assign(new Error(message), { code });
}

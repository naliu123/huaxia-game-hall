export const gomoku = {
  id: 'gomoku',
  title: '五子棋',
  minPlayers: 2,
  maxPlayers: 2,
  initialState() {
    return {
      board: Array.from({ length: 15 }, () => Array(15).fill(0)),
      turn: 1,
      winner: 0,
      moves: [],
      undoRequest: null,
      drawRequest: null,
      endReason: null
    };
  },
  reduce(state, action, context) {
    if (action.type === 'place') return place(state, action, context);
    if (action.type === 'requestUndo') return requestUndo(state, context);
    if (action.type === 'answerUndo') return answerUndo(state, action, context);
    if (action.type === 'requestDraw') return requestDraw(state, context);
    if (action.type === 'answerDraw') return answerDraw(state, action, context);
    if (action.type === 'surrender') return surrender(state, context);
    if (action.type === 'restart') return restart(state, context);
    throw new Error('未知的游戏操作');
  }
};

function place(state, action, { playerIndex, players }) {
  const { row, col } = action;
  if (players.filter(player => !player.expired).length < 2) throw new Error('请等待另一位玩家加入');
  if (state.winner) throw new Error('本局已经结束');
  if (state.undoRequest || state.drawRequest) throw new Error('请先处理当前请求');
  if (playerIndex !== state.turn) throw new Error('还没轮到你');
  if (!Number.isInteger(row) || !Number.isInteger(col) || row < 0 || col < 0 || row >= 15 || col >= 15) throw new Error('落子位置无效');
  if (state.board[row][col]) throw new Error('这里已经有棋子');
  const next = structuredClone(state);
  next.board[row][col] = playerIndex;
  next.moves.push({ row, col, player: playerIndex });
  if (hasFive(next.board, row, col, playerIndex)) {
    next.winner = playerIndex;
    next.endReason = 'five';
  } else if (next.moves.length === 225) {
    next.winner = -1;
    next.endReason = 'board-full';
  }
  else next.turn = playerIndex === 1 ? 2 : 1;
  return next;
}

function requestUndo(state, { playerIndex }) {
  if (!state.moves.length) throw new Error('当前没有可以撤销的棋步');
  if (state.winner) throw new Error('对局结束后不能悔棋');
  if (state.undoRequest) throw new Error('已有待处理的悔棋请求');
  const next = structuredClone(state);
  next.undoRequest = { from: playerIndex };
  return next;
}

function answerUndo(state, action, { playerIndex }) {
  if (!state.undoRequest) throw new Error('没有待处理的悔棋请求');
  if (state.undoRequest.from === playerIndex) throw new Error('不能回应自己的悔棋请求');
  if (typeof action.accept !== 'boolean') throw new Error('悔棋回应格式无效');
  const next = structuredClone(state);
  if (action.accept) {
    const last = next.moves.pop();
    next.board[last.row][last.col] = 0;
    next.turn = last.player;
    next.winner = 0;
  }
  next.undoRequest = null;
  return next;
}

function requestDraw(state, { playerIndex }) {
  if (state.winner) throw new Error('本局已经结束');
  if (state.drawRequest || state.undoRequest) throw new Error('已有待处理请求');
  const next = structuredClone(state);
  next.drawRequest = { from: playerIndex };
  return next;
}

function answerDraw(state, action, { playerIndex }) {
  if (!state.drawRequest) throw new Error('没有待处理的求和请求');
  if (state.drawRequest.from === playerIndex) throw new Error('不能回应自己的求和请求');
  if (typeof action.accept !== 'boolean') throw new Error('求和回应格式无效');
  const next = structuredClone(state);
  if (action.accept) {
    next.winner = -1;
    next.endReason = 'agreed-draw';
  }
  next.drawRequest = null;
  return next;
}

function surrender(state, { playerIndex }) {
  if (state.winner) throw new Error('本局已经结束');
  const next = structuredClone(state);
  next.winner = playerIndex === 1 ? 2 : 1;
  next.endReason = 'surrender';
  return next;
}

function restart(state, { players }) {
  if (!state.winner) throw new Error('当前对局尚未结束');
  if (players.filter(player => !player.expired).length < 2) throw new Error('请等待另一位玩家加入');
  return gomoku.initialState();
}

function hasFive(board, row, col, player) {
  return [[1, 0], [0, 1], [1, 1], [1, -1]].some(([dr, dc]) => {
    let count = 1;
    for (const sign of [-1, 1]) {
      let r = row + dr * sign;
      let c = col + dc * sign;
      while (r >= 0 && r < 15 && c >= 0 && c < 15 && board[r][c] === player) {
        count++;
        r += dr * sign;
        c += dc * sign;
      }
    }
    return count >= 5;
  });
}

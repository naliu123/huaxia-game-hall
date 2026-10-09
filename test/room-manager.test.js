import test from 'node:test';
import assert from 'node:assert/strict';
import { RoomManager } from '../src/room-manager.js';
import { gomoku } from '../src/games/gomoku.js';
const socket=()=>({readyState:1,sent:[],send(data){this.sent.push(JSON.parse(data));},close(){this.readyState=3;}});
test('创建、加入和观战遵循双人房间规则',()=>{const m=new RoomManager({games:[gomoku],reconnectWindowMs:20});const r=m.create();const one=m.join(r.id,socket()).player,two=m.join(r.id.toLowerCase(),socket()).player,v=socket(),watcher=m.join(r.id,v).player;assert.equal(one.index,1);assert.equal(two.index,2);assert.equal(watcher,undefined);assert.equal(v.playerIndex,0);});
test('持有令牌的玩家可在断线窗口内恢复原席位',()=>{const m=new RoomManager({games:[gomoku],reconnectWindowMs:20});const r=m.create(),old=socket(),original=m.join(r.id,old).player;m.leave(old);const fresh=socket(),restored=m.join(r.id,fresh,original.token).player;assert.equal(restored.index,1);assert.equal(restored.connected,true);assert.equal(fresh.playerToken,original.token);});
test('广播为每个连接附带各自身份',()=>{const m=new RoomManager({games:[gomoku]});const r=m.create(),a=socket(),b=socket();m.join(r.id,a);m.join(r.id,b);m.broadcast(r);assert.equal(a.sent.at(-1).room.viewer.index,1);assert.equal(b.sent.at(-1).room.viewer.index,2);assert.equal(a.sent.at(-1).room.players.length,2);});

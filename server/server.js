// 掼蛋局域网联机服务器 —— 完整规则版（进贡/抗贡/升级/逢人配）
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');
const cards = require('./cards');

const PORT = process.env.PORT || 3000;
const ROOT = path.join(__dirname, '..');

// ============ 静态文件服务 ============
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
};

const server = http.createServer((req, res) => {
  let urlPath = decodeURIComponent(req.url.split('?')[0]);
  if (urlPath === '/') urlPath = '/public/index.html';
  if (urlPath.startsWith('/sources/')) {
    // 素材直接映射
  } else if (urlPath.startsWith('/public/')) {
  } else {
    urlPath = '/public' + urlPath;
  }
  const filePath = path.join(ROOT, urlPath.replace(/^\/+/, ''));
  if (!filePath.startsWith(ROOT)) { res.writeHead(403); res.end('Forbidden'); return; }
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not Found'); return; }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  });
});

// ============ WebSocket 游戏服务 ============
const wss = new WebSocket.Server({ server });
const rooms = new Map();
const LEVELS = cards.LEVEL_SEQUENCE;

function makeRoom(roomId, hostId, hostName) {
  return {
    id: roomId,
    players: [],
    status: 'waiting',        // waiting | tribute | playing | over
    hostId,
    level: '2',              // 本局生效级牌
    teamLevels: ['2', '2'],  // 两队升级进度 [队0(座0/2), 队1(座1/3)]
    currentSeat: -1,
    lastPlay: null,
    lastPlaySeat: -1,
    passCount: 0,
    round: 0,
    dealer: -1,               // 上局头游座位，本局先出
    firstOut: null,
    rank: [],                 // 本局名次 [seat...] 头游→末游
    // 进贡状态机
    tribute: null,            // { type: 'single'|'double'|'resist', ... }
    waitingTribute: [],       // 等待进贡的座位
    returnTribute: [],        // 等待还贡的座位
  };
}

function broadcast(room, msg) {
  const data = JSON.stringify(msg);
  for (const p of room.players) {
    if (p.ws && p.ws.readyState === WebSocket.OPEN) p.ws.send(data);
  }
}
function sendTo(ws, msg) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

function privateState(room, playerId) {
  const me = room.players.find(p => p.id === playerId);
  if (!me) return null;
  return {
    type: 'state',
    roomId: room.id,
    status: room.status,
    level: room.level,
    teamLevels: room.teamLevels,   // 两队升级进度
    currentSeat: room.currentSeat,
    lastPlay: room.lastPlay,
    lastPlaySeat: room.lastPlaySeat,
    passCount: room.passCount,
    round: room.round,
    dealer: room.dealer,
    firstOut: room.firstOut,
    rank: room.rank,
    tribute: room.tribute ? { type: room.tribute.type } : null,
    mySeat: me.seat,
    myHand: me.hand,
    myNeedTribute: me.needTribute || false,   // 是否需要进贡
    myNeedReturn: me.needReturn || false,     // 是否需要还贡
    players: room.players.map(p => ({
      id: p.id, name: p.name, seat: p.seat,
      handCount: p.hand.length, ready: p.ready,
      online: p.ws !== null, isHost: p.id === room.hostId,
    })),
  };
}

function broadcastState(room) {
  for (const p of room.players) {
    if (p.ws) {
      const st = privateState(room, p.id);
      if (st) sendTo(p.ws, st);
    }
  }
}

// ============ 发牌 ============
function dealCards(room) {
  const deck = cards.shuffle(cards.createDeck());
  const hands = [[], [], [], []];
  for (let i = 0; i < deck.length; i++) hands[i % 4].push(deck[i]);
  for (const h of hands) {
    h.sort((a, b) => cards.singleCompareValue(b, room.level) - cards.singleCompareValue(a, room.level));
  }
  room.players.forEach((p, i) => { p.hand = hands[i]; });
}

function startPlaying(room) {
  room.status = 'playing';
  room.lastPlay = null;
  room.lastPlaySeat = -1;
  room.passCount = 0;
  room.firstOut = null;
  room.rank = [];
  // 先手：进贡大牌者 / 头游 / 首局房主
  if (room.firstLeadSeat !== undefined && room.firstLeadSeat >= 0) {
    room.currentSeat = room.firstLeadSeat;
  } else if (room.dealer >= 0) {
    room.currentSeat = room.dealer;
  } else {
    room.currentSeat = 0;
  }
  room.firstLeadSeat = undefined;
  broadcast(room, { type: 'game_start', level: room.level, currentSeat: room.currentSeat, round: room.round });
  broadcastState(room);
}

// 开局（含进贡流程判断）
function startRound(room) {
  room.round += 1;
  dealCards(room);

  // 首局或上一局无贡：直接开始
  if (room.round === 1 || !room.rank || room.rank.length < 4) {
    startPlaying(room);
    return;
  }

  // 计算进贡
  const first = room.rank[0];       // 头游
  const last = room.rank[3];        // 末游
  const firstTeam = first % 2;
  const lastTeam = last % 2;

  // 双下：头游和二游同队（对方包揽头二游，即头游队伍的队友也拿了二游）
  // 单下：头游和末游同队（头游队拿头游+末游，对手拿二游+三游）
  const second = room.rank[1];
  const isDoubleDown = (second % 2) === firstTeam;

  if (isDoubleDown) {
    // 双下：两名输家（三游+末游）各进贡
    // 输家 = 排名3、4的两人
    const loser1 = room.rank[2];
    const loser2 = room.rank[3];
    // 抗贡判定：两输家合计持有两张大王
    const p1 = room.players.find(p => p.seat === loser1);
    const p2 = room.players.find(p => p.seat === loser2);
    const bigJokerCount = [p1, p2].reduce((sum, p) => sum + p.hand.filter(c => c.isJoker && c.jokerType === 'red').length, 0);
    if (bigJokerCount >= 2) {
      // 抗贡
      room.tribute = { type: 'resist' };
      room.firstLeadSeat = first;
      broadcast(room, { type: 'tribute_start', kind: 'resist' });
      startPlaying(room);
      return;
    }
    // 双下进贡
    room.tribute = { type: 'double', losers: [loser1, loser2], winners: [room.rank[0], room.rank[1]] };
    room.players.find(p => p.seat === loser1).needTribute = true;
    room.players.find(p => p.seat === loser2).needTribute = true;
    room.waitingTribute = [loser1, loser2];
    room.status = 'tribute';
    broadcast(room, { type: 'tribute_start', kind: 'double', losers: [loser1, loser2] });
    broadcastState(room);
  } else {
    // 单下：末游（头游队友）向头游进贡
    room.tribute = { type: 'single', loser: last, winner: first };
    const loser = room.players.find(p => p.seat === last);
    // 抗贡判定：末游持有两张大王
    const bigJokerCount = loser.hand.filter(c => c.isJoker && c.jokerType === 'red').length;
    if (bigJokerCount >= 2) {
      room.tribute = { type: 'resist' };
      room.firstLeadSeat = first;
      broadcast(room, { type: 'tribute_start', kind: 'resist' });
      startPlaying(room);
      return;
    }
    loser.needTribute = true;
    room.waitingTribute = [last];
    room.status = 'tribute';
    broadcast(room, { type: 'tribute_start', kind: 'single', loser: last, winner: first });
    broadcastState(room);
  }
}

// ============ 进贡处理 ============
function handleTribute(ws, player, room, cardIds) {
  if (room.status !== 'tribute') return;
  if (!room.waitingTribute.includes(player.seat)) {
    sendTo(ws, { type: 'error', msg: '现在不需要你进贡' });
    return;
  }
  // 取牌
  const tributeCards = [];
  const remaining = [];
  for (const c of player.hand) {
    if (cardIds.includes(c.id)) tributeCards.push(c);
    else remaining.push(c);
  }
  if (tributeCards.length !== 1) {
    sendTo(ws, { type: 'error', msg: '进贡必须选一张牌' });
    return;
  }
  const card = tributeCards[0];
  // 不能贡红桃级牌
  if (cards.isHeartLevel(card, room.level)) {
    sendTo(ws, { type: 'error', msg: '不能进贡红桃级牌（逢人配）' });
    return;
  }
  // 必须是除红桃级牌外的最大牌
  const maxVal = player.hand.filter(c => !cards.isHeartLevel(c, room.level))
    .reduce((m, c) => Math.max(m, cards.singleCompareValue(c, room.level)), -1);
  if (cards.singleCompareValue(card, room.level) < maxVal) {
    sendTo(ws, { type: 'error', msg: '必须进贡除红桃级牌外的最大牌' });
    return;
  }

  player.hand = remaining;
  player.needTribute = false;
  room.waitingTribute = room.waitingTribute.filter(s => s !== player.seat);

  // 记录贡牌
  if (!room.tribute.tributeCards) room.tribute.tributeCards = {};
  room.tribute.tributeCards[player.seat] = card;

  broadcast(room, { type: 'tribute_done', seat: player.seat, name: player.name });

  // 所有人贡完 => 进入还贡
  if (room.waitingTribute.length === 0) {
    enterReturnTribute(room);
  }
  broadcastState(room);
}

// 进入还贡阶段：头游（和双下时的二游）还牌
function enterReturnTribute(room) {
  room.status = 'tribute';
  room.waitingTribute = [];
  const tc = room.tribute.tributeCards || {};

  if (room.tribute.type === 'single') {
    // 头游还一张 ≤10 的牌
    const winner = room.players.find(p => p.seat === room.tribute.winner);
    winner.needReturn = true;
    room.returnTribute = [winner.seat];
  } else if (room.tribute.type === 'double') {
    // 头游拿大贡，二游拿小贡，各自还牌
    const loser1 = room.tribute.losers[0];
    const loser2 = room.tribute.losers[1];
    const c1 = tc[loser1], c2 = tc[loser2];
    const v1 = cards.singleCompareValue(c1, room.level);
    const v2 = cards.singleCompareValue(c2, room.level);
    const bigLoser = v1 >= v2 ? loser1 : loser2;
    const smallLoser = v1 >= v2 ? loser2 : loser1;
    // 头游拿大贡，二游拿小贡
    const winner1 = room.players.find(p => p.seat === room.tribute.winners[0]); // 头游
    const winner2 = room.players.find(p => p.seat === room.tribute.winners[1]); // 二游
    winner1.needReturn = true;
    winner2.needReturn = true;
    room.returnTribute = [winner1.seat, winner2.seat];
    // 记录贡牌归属
    room.tribute.bigLoser = bigLoser;
    room.tribute.smallLoser = smallLoser;
    room.firstLeadSeat = bigLoser; // 进贡大牌者先出
  }

  broadcast(room, { type: 'return_tribute_start' });
  broadcastState(room);
}

// 还贡
function handleReturnTribute(ws, player, room, cardIds) {
  if (room.status !== 'tribute') return;
  if (!room.returnTribute.includes(player.seat)) {
    sendTo(ws, { type: 'error', msg: '现在不需要你还贡' });
    return;
  }
  const returnCards = [];
  const remaining = [];
  for (const c of player.hand) {
    if (cardIds.includes(c.id)) returnCards.push(c);
    else remaining.push(c);
  }
  if (returnCards.length !== 1) {
    sendTo(ws, { type: 'error', msg: '还贡必须选一张牌' });
    return;
  }
  const card = returnCards[0];
  // 规则：还一张 ≤10 的任意牌（王和级牌除外，简化：非王且点数≤10）
  if (!card.isJoker && cards.baseValue(card.rank) > 10) {
    sendTo(ws, { type: 'error', msg: '还贡应还一张点数≤10的牌' });
    return;
  }

  player.hand = remaining;
  player.needReturn = false;
  room.returnTribute = room.returnTribute.filter(s => s !== player.seat);

  // 还贡牌给输家
  if (!room.tribute.returnCards) room.tribute.returnCards = {};
  room.tribute.returnCards[player.seat] = card;

  broadcast(room, { type: 'return_done', seat: player.seat, name: player.name });

  if (room.returnTribute.length === 0) {
    finishTribute(room);
  }
  broadcastState(room);
}

// 完成进贡：交换牌
function finishTribute(room) {
  const tc = room.tribute.tributeCards || {};
  const rc = room.tribute.returnCards || {};

  if (room.tribute.type === 'single') {
    const loserSeat = room.tribute.loser;
    const winnerSeat = room.tribute.winner;
    const loser = room.players.find(p => p.seat === loserSeat);
    const winner = room.players.find(p => p.seat === winnerSeat);
    // 输家拿到还贡牌，头游拿到贡牌
    winner.hand.push(tc[loserSeat]);
    loser.hand.push(rc[winnerSeat]);
    room.firstLeadSeat = loserSeat; // 进贡者先出（单下时末游先进贡后先出？规则：进贡大牌者先出）
  } else if (room.tribute.type === 'double') {
    const bigLoser = room.tribute.bigLoser;
    const smallLoser = room.tribute.smallLoser;
    const winner1 = room.players.find(p => p.seat === room.tribute.winners[0]); // 头游拿大贡
    const winner2 = room.players.find(p => p.seat === room.tribute.winners[1]); // 二游拿小贡
    winner1.hand.push(tc[bigLoser]);
    winner2.hand.push(tc[smallLoser]);
    room.players.find(p => p.seat === bigLoser).hand.push(rc[winner1.seat]);
    room.players.find(p => p.seat === smallLoser).hand.push(rc[winner2.seat]);
    room.firstLeadSeat = bigLoser; // 进贡大牌者先出
  }

  // 重新排序手牌
  for (const p of room.players) {
    p.hand.sort((a, b) => cards.singleCompareValue(b, room.level) - cards.singleCompareValue(a, room.level));
    p.needTribute = false;
    p.needReturn = false;
  }

  room.tribute = null;
  room.waitingTribute = [];
  room.returnTribute = [];
  startPlaying(room);
}

// ============ 出牌 ============
function handlePlay(ws, player, room, cardIds) {
  if (room.status !== 'playing') return;
  if (room.currentSeat !== player.seat) {
    sendTo(ws, { type: 'error', msg: '还没轮到你出牌' });
    return;
  }
  const playCards = [];
  const remaining = [];
  for (const c of player.hand) {
    if (cardIds.includes(c.id)) playCards.push(c);
    else remaining.push(c);
  }
  if (playCards.length !== cardIds.length) {
    sendTo(ws, { type: 'error', msg: '出牌包含无效的牌' });
    return;
  }
  const play = cards.analyzeCards(playCards, room.level);
  if (!play) {
    sendTo(ws, { type: 'error', msg: '无效的牌型' });
    return;
  }
  const mustBeat = room.lastPlay && room.lastPlaySeat !== player.seat;
  if (mustBeat && !cards.canBeat(playCards, room.lastPlay.cards, room.level)) {
    sendTo(ws, { type: 'error', msg: '压不过上家的牌' });
    return;
  }

  player.hand = remaining;
  room.lastPlay = { seat: player.seat, cards: playCards, type: play.type, mainValue: play.mainValue };
  room.lastPlaySeat = player.seat;
  room.passCount = 0;

  if (player.hand.length === 0) {
    room.rank.push(player.seat);
    if (!room.firstOut) {
      room.firstOut = player.seat;
      room.dealer = player.seat;
    }
  }

  broadcast(room, { type: 'play', seat: player.seat, cards: playCards, type: play.type, name: player.name });

  // 对局结束：3家出完
  if (room.rank.length >= 3) {
    // 第4家为末游
    const lastPlayer = room.players.find(p => !room.rank.includes(p.seat));
    if (lastPlayer) room.rank.push(lastPlayer.seat);
    endRound(room);
    return;
  }

  advanceTurn(room);
  broadcastState(room);
}

function advanceTurn(room) {
  let next = room.currentSeat;
  for (let i = 0; i < 4; i++) {
    next = (next + 1) % 4;
    const p = room.players.find(pl => pl.seat === next);
    if (p && p.hand.length > 0) { room.currentSeat = next; return; }
  }
  room.currentSeat = -1;
}

function handlePass(ws, player, room) {
  if (room.status !== 'playing') return;
  if (room.currentSeat !== player.seat) {
    sendTo(ws, { type: 'error', msg: '还没轮到你' });
    return;
  }
  if (!room.lastPlay || room.lastPlaySeat === player.seat) {
    sendTo(ws, { type: 'error', msg: '你必须出牌（自由出牌不能过）' });
    return;
  }
  room.passCount++;
  broadcast(room, { type: 'pass', seat: player.seat, name: player.name });

  // 还在出牌的玩家数量（未出完的）
  const activePlayers = room.players.filter(p => p.hand.length > 0).length;
  // 其他未出完玩家都过 => 接风
  if (room.passCount >= activePlayers - 1) {
    // 接风：若出牌者已出完，则其队友获得领出权；否则出牌者继续
    const lastPlayer = room.players.find(p => p.seat === room.lastPlaySeat);
    if (lastPlayer && lastPlayer.hand.length === 0) {
      // 出牌者已出完，接风给对家
      const teammateSeat = (room.lastPlaySeat + 2) % 4;
      const teammate = room.players.find(p => p.seat === teammateSeat);
      if (teammate && teammate.hand.length > 0) {
        room.currentSeat = teammateSeat;
      }
    } else {
      room.currentSeat = room.lastPlaySeat;
    }
    room.lastPlay = null;
    room.lastPlaySeat = -1;
    room.passCount = 0;
    broadcast(room, { type: 'wind', seat: room.currentSeat });
  } else {
    advanceTurn(room);
  }
  broadcastState(room);
}

// ============ 结束一局，计算升级 ============
function endRound(room) {
  room.status = 'over';
  const first = room.players.find(p => p.seat === room.rank[0]);
  const firstTeam = room.rank[0] % 2;

  // 头游队友的名次
  const teammateSeat = (room.rank[0] + 2) % 4;
  const teammateRank = room.rank.indexOf(teammateSeat); // 0=头游,1=二游,2=三游,3=末游

  // 升级规则：
  // 头游+二游同队（双下对方）→ 升3级
  // 头游+三游同队 → 升2级
  // 头游+末游同队（单下）→ 升1级
  let upgrade;
  if (teammateRank === 1) upgrade = 3;
  else if (teammateRank === 2) upgrade = 2;
  else upgrade = 1; // teammateRank === 3

  const levelIndex = LEVELS.indexOf(room.level);
  let newLevelIndex = levelIndex + upgrade;
  // A 级特殊：打 A 时必须头游才能赢（此处简化为：A 后打过头即赢）
  let win = false;
  if (newLevelIndex >= LEVELS.length) {
    if (room.level === 'A' && room.rank[0] === first.seat) {
      // 打 A 且头游，获胜
      win = true;
      newLevelIndex = LEVELS.length - 1;
    } else {
      newLevelIndex = LEVELS.length - 1;
    }
  }
  const newLevel = LEVELS[newLevelIndex];
  // 更新获胜队伍的级牌进度，本局级牌跟随获胜队伍
  const winningTeam = first.seat % 2;
  room.teamLevels[winningTeam] = newLevel;
  room.level = newLevel;

  broadcast(room, {
    type: 'round_end',
    firstOutSeat: first.seat,
    firstOutName: first.name,
    order: room.rank,
    upgrade,
    newLevel,
    win,
  });

  // 8秒后进入下一局（含进贡流程）
  setTimeout(() => {
    if (rooms.has(room.id) && room.status === 'over') {
      startRound(room);
    }
  }, 8000);
}

// ============ 消息处理 ============
wss.on('connection', (ws) => {
  ws.playerId = null;
  ws.roomId = null;

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch (e) { return; }

    switch (msg.type) {
      case 'create_room': {
        const roomId = Math.random().toString(36).slice(2, 7).toUpperCase();
        const room = makeRoom(roomId, 'host', msg.name || '房主');
        const player = { id: 'host', name: msg.name || '房主', seat: 0, hand: [], ready: false, ws };
        room.players.push(player);
        rooms.set(roomId, room);
        ws.playerId = 'host';
        ws.roomId = roomId;
        sendTo(ws, { type: 'room_created', roomId, playerId: 'host', seat: 0 });
        broadcastState(room);
        break;
      }
      case 'join_room': {
        const room = rooms.get(msg.roomId);
        if (!room) { sendTo(ws, { type: 'error', msg: '房间不存在' }); break; }
        if (room.status === 'playing' || room.status === 'tribute') { sendTo(ws, { type: 'error', msg: '对局已开始，无法加入' }); break; }
        if (room.players.length >= 4) { sendTo(ws, { type: 'error', msg: '房间已满' }); break; }
        const playerId = 'p' + Date.now();
        const seat = room.players.length;
        const player = { id: playerId, name: msg.name || ('玩家' + seat), seat, hand: [], ready: false, ws };
        room.players.push(player);
        ws.playerId = playerId;
        ws.roomId = msg.roomId;
        sendTo(ws, { type: 'joined', roomId: msg.roomId, playerId, seat });
        broadcastState(room);
        break;
      }
      case 'ready': {
        const room = rooms.get(ws.roomId);
        if (!room) break;
        const player = room.players.find(p => p.id === ws.playerId);
        if (player) { player.ready = !player.ready; }
        broadcastState(room);
        break;
      }
      case 'start': {
        const room = rooms.get(ws.roomId);
        if (!room) break;
        const player = room.players.find(p => p.id === ws.playerId);
        if (!player || player.id !== room.hostId) { sendTo(ws, { type: 'error', msg: '只有房主能开始' }); break; }
        if (room.players.length < 4) { sendTo(ws, { type: 'error', msg: '需要4名玩家才能开始' }); break; }
        if (!room.players.every(p => p.ready)) { sendTo(ws, { type: 'error', msg: '还有玩家未准备' }); break; }
        if (room.round === 0) startRound(room);
        break;
      }
      case 'play': {
        const room = rooms.get(ws.roomId);
        if (!room) break;
        const player = room.players.find(p => p.id === ws.playerId);
        if (player) handlePlay(ws, player, room, msg.cardIds);
        break;
      }
      case 'pass': {
        const room = rooms.get(ws.roomId);
        if (!room) break;
        const player = room.players.find(p => p.id === ws.playerId);
        if (player) handlePass(ws, player, room);
        break;
      }
      case 'tribute': {
        const room = rooms.get(ws.roomId);
        if (!room) break;
        const player = room.players.find(p => p.id === ws.playerId);
        if (player) handleTribute(ws, player, room, msg.cardIds);
        break;
      }
      case 'return_tribute': {
        const room = rooms.get(ws.roomId);
        if (!room) break;
        const player = room.players.find(p => p.id === ws.playerId);
        if (player) handleReturnTribute(ws, player, room, msg.cardIds);
        break;
      }
      case 'chat': {
        const room = rooms.get(ws.roomId);
        if (!room) break;
        const player = room.players.find(p => p.id === ws.playerId);
        if (player) broadcast(room, { type: 'chat', seat: player.seat, name: player.name, text: msg.text });
        break;
      }
    }
  });

  ws.on('close', () => {
    const room = rooms.get(ws.roomId);
    if (!room) return;
    const player = room.players.find(p => p.id === ws.playerId);
    if (!player) return;
    if (room.status === 'waiting') {
      room.players = room.players.filter(p => p.id !== player.id);
      room.players.forEach((p, i) => p.seat = i);
      if (room.players.length === 0) { rooms.delete(room.id); return; }
      if (player.id === room.hostId && room.players.length > 0) room.hostId = room.players[0].id;
      broadcastState(room);
    } else {
      player.ws = null;
      broadcastState(room);
    }
  });
});

server.listen(PORT, '0.0.0.0', () => {
  const os = require('os');
  const nets = os.networkInterfaces();
  console.log('掼蛋服务器已启动！');
  console.log('本机访问: http://localhost:' + PORT);
  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      if (net.family === 'IPv4' && !net.internal) {
        console.log('局域网访问: http://' + net.address + ':' + PORT);
      }
    }
  }
});

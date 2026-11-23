// 掼蛋前端游戏逻辑
'use strict';

let ws = null;
let myPlayerId = null;
let mySeat = -1;
let myRoomId = null;
let myName = '';
let gameState = null;
let selectedCards = new Set();

const SUIT_CN = { spades: '♠', hearts: '♥', clubs: '♣', diamonds: '♦' };
const RANK_CN = { '10': '10', 'J': 'J', 'Q': 'Q', 'K': 'K', 'A': 'A', '2': '2' };
const TYPE_CN = {
  single: '单张', pair: '对子', trio: '三张', trio_pair: '三带二',
  straight: '顺子', pair_straight: '连对', trio_straight: '钢板',
  bomb: '炸弹', straight_flush: '同花顺', joker_bomb: '王炸'
};

// ============ 工具 ============
function $(id) { return document.getElementById(id); }
function toast(msg, ms = 2000) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(t._timer);
  t._timer = setTimeout(() => t.classList.remove('show'), ms);
}

const RANK_IMG = { 'J': 'jack', 'Q': 'queen', 'K': 'king', 'A': 'ace' };
function cardImg(card) {
  if (card.isJoker) return `/sources/image/jokers/${card.jokerType === 'red' ? 'red joker' : 'black joker'}.png`;
  const name = RANK_IMG[card.rank] || card.rank;
  return `/sources/image/${card.suit}/${name} of ${card.suit}.png`;
}

function rankDisplay(card) {
  if (card.isJoker) return card.jokerType === 'red' ? '大王' : '小王';
  return card.rank;
}

// 座位显示映射：自己(mySeat)固定显示在下方(显示位置0)，对家在上方(2)，右手下家(1)，左手上家(3)
// 显示位置约定（对应 CSS .seat-N）：0=下 1=右 2=上 3=左
function seatToDisplay(seat, mySeat) {
  const rel = (seat - mySeat + 4) % 4; // 相对位置：0=自己 1=下家(右手) 2=对家 3=上家(左手)
  // rel 0(自己)→0(下), rel 1(下家)→1(右), rel 2(对家)→2(上), rel 3(上家)→3(左)
  const map = { 0: 0, 1: 1, 2: 2, 3: 3 };
  return map[rel];
}
function displayToSeat(displaySeat, mySeat) {
  const revMap = { 0: 0, 1: 1, 2: 2, 3: 3 };
  const rel = revMap[displaySeat];
  return (mySeat + rel) % 4;
}

// 连接
function connect() {
  const proto = location.protocol === 'https:' ? 'wss://' : 'ws://';
  ws = new WebSocket(proto + location.host);

  ws.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    handleMessage(msg);
  };
  ws.onclose = () => { toast('连接断开，请刷新重试', 4000); };
  ws.onerror = () => { toast('连接错误', 3000); };
}

// ============ 大厅 ============
function createRoom() {
  myName = $('nickname').value.trim() || '玩家';
  connectAndWait(() => {
    ws.send(JSON.stringify({ type: 'create_room', name: myName }));
  });
}
function showJoin() {
  $('joinArea').style.display = 'block';
}
function joinRoom() {
  myName = $('nickname').value.trim() || '玩家';
  myRoomId = $('roomIdInput').value.trim().toUpperCase();
  if (!myRoomId) { toast('请输入房间号'); return; }
  connectAndWait(() => {
    ws.send(JSON.stringify({ type: 'join_room', roomId: myRoomId, name: myName }));
  });
}
function connectAndWait(fn) {
  connect();
  ws.onopen = fn;
}

// ============ 消息处理 ============
function handleMessage(msg) {
  switch (msg.type) {
    case 'room_created':
      myRoomId = msg.roomId;
      myPlayerId = msg.playerId;
      mySeat = msg.seat;
      showWaiting();
      break;
    case 'joined':
      myRoomId = msg.roomId;
      myPlayerId = msg.playerId;
      mySeat = msg.seat;
      showWaiting();
      break;
    case 'state':
      gameState = msg;
      renderWaiting();
      renderGame();
      break;
    case 'game_start':
      toast(`第 ${msg.round} 局开始，级牌：${msg.level}`, 3000);
      break;
    case 'play':
      toast(`${msg.name} 出了 ${TYPE_CN[msg.type] || '牌'}`);
      flashPlayArea(msg.seat);
      break;
    case 'pass':
      toast(`${msg.name} 不出`);
      break;
    case 'wind':
      toast('其余玩家都不出，接风！');
      break;
    case 'tribute_start':
      if (msg.kind === 'resist') toast('进贡方持有两张大王，抗贡！由头游先出');
      else if (msg.kind === 'double') toast('双下！两名输家需各进贡一张最大牌');
      else toast('单下！末游需进贡一张最大牌');
      break;
    case 'return_tribute_start':
      toast('进贡完成，等待还贡');
      break;
    case 'round_end':
      const names = ['一游', '二游', '三游', '末游'];
      const upgradeTxt = msg.upgrade === 3 ? '双下，升3级' : msg.upgrade === 2 ? '升2级' : '升1级';
      toast(`本局结束！${msg.firstOutName} 是头游，${upgradeTxt}，现在打 ${msg.newLevel}${msg.win ? '，获胜！' : ''}`);
      break;
    case 'chat':
      addChat(msg.name, msg.text);
      break;
    case 'error':
      toast(msg.msg, 2500);
      break;
  }
}

// ============ 等待室 ============
function showWaiting() {
  $('lobby').style.display = 'none';
  $('waiting').style.display = 'flex';
  $('game').style.display = 'none';
  $('waitRoomId').textContent = myRoomId;
  $('waitRoomUrl').textContent = `其他玩家在浏览器打开 ${location.origin}，输入房间号即可加入`;
}

function renderWaiting() {
  if (!gameState) return;
  if ($('waiting').style.display === 'none') return;
  const grid = $('playerGrid');
  grid.innerHTML = '';
  const slots = [0, 1, 2, 3];
  for (const seat of slots) {
    const p = gameState.players.find(x => x.seat === seat);
    const div = document.createElement('div');
    div.className = 'player-slot' + (p ? ' filled' : '');
    if (p) {
      div.innerHTML = `<div class="pname">${p.name}${p.isHost ? ' (房主)' : ''}${p.seat === mySeat ? ' (我)' : ''}</div>
        <div class="pstatus ${p.ready ? 'ready' : ''}">${p.ready ? '已准备' : '未准备'}</div>`;
    } else {
      div.innerHTML = '<div class="pname" style="color:#bbb;">等待加入...</div>';
    }
    grid.appendChild(div);
  }
  // 准备按钮状态
  const me = gameState.players.find(x => x.id === myPlayerId);
  if (me) {
    $('readyBtn').textContent = me.ready ? '取消准备' : '准备';
  }
  // 房主显示开始按钮
  const isHost = me && me.isHost;
  $('startBtn').style.display = isHost ? 'block' : 'none';
  $('startBtn').disabled = !(gameState.players.length === 4 && gameState.players.every(x => x.ready));
}

function toggleReady() {
  ws.send(JSON.stringify({ type: 'ready' }));
}
function startGame() {
  ws.send(JSON.stringify({ type: 'start' }));
}
function leaveRoom() {
  ws.close();
  location.reload();
}

// ============ 游戏渲染 ============
function renderGame() {
  if (!gameState) return;
  if (gameState.status === 'playing' || gameState.status === 'over' || gameState.status === 'tribute') {
    $('waiting').style.display = 'none';
    $('lobby').style.display = 'none';
    $('game').style.display = 'block';
  } else {
    return;
  }

  $('levelIndicator').textContent = gameState.level;
  $('levelBadge').textContent = gameState.level;
  $('roundBadge').textContent = gameState.round;
  // 两队升级进度
  if (gameState.teamLevels) {
    $('teamLevel0').textContent = gameState.teamLevels[0];
    $('teamLevel1').textContent = gameState.teamLevels[1];
  }

  // 渲染座位：自己固定显示在下方，对家在上方，下家右、上家左
  for (let seat = 0; seat < 4; seat++) {
    const p = gameState.players.find(x => x.seat === seat);
    // 计算显示位置：自己坐下，对家坐上，左右为下家/上家
    const displaySeat = seatToDisplay(seat, mySeat);
    const el = $('seat-' + displaySeat);
    if (p) {
      el.innerHTML = `
        <div class="avatar">${p.name.charAt(0)}</div>
        <div class="sname">${p.name}${p.seat === mySeat ? '(我)' : ''}</div>
        <div class="scount">${p.seat === mySeat || p.handCount <= 10 ? `剩 ${p.handCount} 张` : ''}</div>`;
      el.classList.toggle('active', p.seat === gameState.currentSeat);
    }
  }

  // 渲染手牌
  renderHand();

  // 渲染出牌区
  renderPlayArea();

  // 按钮状态
  if (gameState.status === 'tribute') {
    // 进贡/还贡状态
    const playBtn = $('playBtn');
    const passBtn = $('passBtn');
    if (gameState.myNeedTribute) {
      playBtn.textContent = '进贡';
      playBtn.disabled = false;
    } else if (gameState.myNeedReturn) {
      playBtn.textContent = '还贡';
      playBtn.disabled = false;
    } else {
      playBtn.textContent = '出牌';
      playBtn.disabled = true;
    }
    passBtn.disabled = true;
    passBtn.textContent = '不出';
  } else {
    $('playBtn').textContent = '出牌';
    $('passBtn').textContent = '不出';
    const myTurn = gameState.currentSeat === mySeat && gameState.status === 'playing';
    $('playBtn').disabled = !myTurn;
    $('passBtn').disabled = !myTurn || !gameState.lastPlay || gameState.lastPlaySeat === mySeat;
  }
}

function renderHand() {
  const container = $('handCards');
  container.innerHTML = '';
  if (!gameState.myHand) return;
  const hand = gameState.myHand;
  hand.forEach((card, i) => {
    const div = document.createElement('div');
    div.className = 'card' + (selectedCards.has(card.id) ? ' selected' : '');
    div.style.backgroundImage = `url('${cardImg(card)}')`;
    div.title = rankDisplay(card);
    div.onclick = () => toggleSelect(card.id);
    container.appendChild(div);
  });
}

function renderPlayArea() {
  // 清除
  for (let s = 0; s < 4; s++) $('play-' + s).innerHTML = '';
  if (!gameState.lastPlay) return;
  const seat = gameState.lastPlaySeat;
  const displaySeat = seatToDisplay(seat, mySeat);
  const area = $('play-' + displaySeat);
  gameState.lastPlay.cards.forEach(card => {
    const div = document.createElement('div');
    div.className = 'card small';
    div.style.backgroundImage = `url('${cardImg(card)}')`;
    area.appendChild(div);
  });
  const label = document.createElement('div');
  label.className = 'play-type-label';
  label.textContent = TYPE_CN[gameState.lastPlay.type] || '';
  area.appendChild(label);
}

function flashPlayArea(seat) {
  const displaySeat = seatToDisplay(seat, mySeat);
  const area = $('play-' + displaySeat);
  area.style.filter = 'brightness(1.5)';
  setTimeout(() => area.style.filter = '', 400);
}

// ============ 选牌与出牌 ============
function toggleSelect(cardId) {
  if (selectedCards.has(cardId)) selectedCards.delete(cardId);
  else selectedCards.add(cardId);
  renderHand();
}

function doPlay() {
  if (selectedCards.size === 0) { toast('请先选牌'); return; }
  const cardIds = Array.from(selectedCards);
  // 根据状态发送不同消息
  if (gameState && gameState.status === 'tribute') {
    if (gameState.myNeedTribute) {
      ws.send(JSON.stringify({ type: 'tribute', cardIds }));
    } else if (gameState.myNeedReturn) {
      ws.send(JSON.stringify({ type: 'return_tribute', cardIds }));
    }
  } else {
    ws.send(JSON.stringify({ type: 'play', cardIds }));
  }
  selectedCards.clear();
}

function doPass() {
  ws.send(JSON.stringify({ type: 'pass' }));
  selectedCards.clear();
}

// ============ 聊天 ============
function sendChat() {
  const input = $('chatInput');
  const text = input.value.trim();
  if (!text) return;
  ws.send(JSON.stringify({ type: 'chat', text }));
  input.value = '';
}
function addChat(name, text) {
  const box = $('chatMsgs');
  const div = document.createElement('div');
  div.innerHTML = `<span class="sender">${name}：</span>${text}`;
  box.appendChild(div);
  box.scrollTop = box.scrollHeight;
}

// 初始
$('nickname').value = '玩家' + Math.floor(Math.random() * 1000);

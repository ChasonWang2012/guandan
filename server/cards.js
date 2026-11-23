// 掼蛋牌型引擎 —— 完整规则版（含逢人配、炸弹层级、级牌规则）
'use strict';

const SUITS = ['spades', 'hearts', 'clubs', 'diamonds'];
const SUIT_CN = { spades: '♠', hearts: '♥', clubs: '♣', diamonds: '♦' };

// 基础点数（不含级牌/王调整）
const RANK_VALUES = {
  '3': 3, '4': 4, '5': 5, '6': 6, '7': 7, '8': 8, '9': 9, '10': 10,
  'J': 11, 'Q': 12, 'K': 13, 'A': 14, '2': 15,
};
const LEVEL_SEQUENCE = ['2','3','4','5','6','7','8','9','10','J','Q','K','A'];

function rankValue(rank) {
  return RANK_VALUES[rank];
}

// ============ 发牌 ============
function createDeck() {
  const deck = [];
  const ranks = ['2','3','4','5','6','7','8','9','10','J','Q','K','A'];
  for (let copy = 0; copy < 2; copy++) {
    for (const suit of SUITS) {
      for (const rank of ranks) {
        deck.push({
          id: `${copy}_${suit}_${rank}`,
          suit, rank, copy,
          value: rankValue(rank),
          isJoker: false,
        });
      }
    }
  }
  for (let copy = 0; copy < 2; copy++) {
    deck.push({ id: `${copy}_joker_black`, suit: 'black', rank: '小王', copy, value: 16, isJoker: true, jokerType: 'black' });
    deck.push({ id: `${copy}_joker_red`, suit: 'red', rank: '大王', copy, value: 17, isJoker: true, jokerType: 'red' });
  }
  return deck;
}

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// ============ 级牌规则 ============
// 是否级牌（非王的级牌点数）
function isLevelCard(card, level) {
  return !card.isJoker && card.rank === level;
}
// 是否逢人配（红桃级牌）
function isWildcard(card, level) {
  return isLevelCard(card, level) && card.suit === 'hearts';
}
// 是否为红桃级牌（进贡时不可贡出）
function isHeartLevel(card, level) {
  return isLevelCard(card, level) && card.suit === 'hearts';
}

// 单张牌的「牌力值」：大王17 > 小王16 > 级牌15.5 > A14 > K13 > ... > 2(15? 不，2 是15但级牌在15之上)
// 注意：非级牌时 2 的点数是 15（仅次于 A 之上？不对）
// 掼蛋基础大小：大王 > 小王 > 级牌 > A > K > Q > J > 10 > ... > 3 > 2
// 即 2 是最小的普通牌！重新定义基础点数
// 3=3 ... 10=10 J=11 Q=12 K=13 A=14, 2=15? 但规则说 A > ... > 2
// 重新读规则：大王 > 小王 > 级牌 > A > K > … > 2
// 所以 2 排在最后，2 最小。但 A 是 14，2 应该是 15 还是比 3 还小？
// 规则明确：A > K > ... > 2，即 2 < 3。所以 2 是最小的。
// 但顺子 A-2-3-4-5 中 2 当 2 用。

// 定义基础点数：2=2 最小, 3=3, ..., A=14（这样 2 < 3 正确）
// 但普通单张大小：A(14) > K(13) > ... > 3(3) > 2(2)。符合"2最小"。
// 级牌作为特殊值 15.5（介于 A=14 和小王=16 之间，符合"级牌 > A"）

const BASE_VALUES = {
  '2': 2, '3': 3, '4': 4, '5': 5, '6': 6, '7': 7, '8': 8, '9': 9, '10': 10,
  'J': 11, 'Q': 12, 'K': 13, 'A': 14,
};

function baseValue(rank) {
  return BASE_VALUES[rank];
}

// 单张比较值（用于比大小，含级牌提升）
function singleCompareValue(card, level) {
  if (card.isJoker) return card.value;      // 16 小王, 17 大王
  if (isLevelCard(card, level)) return 15.5; // 级牌 > A(14) < 小王(16)
  return BASE_VALUES[card.rank] || 0;
}

// 顺子/连对/钢板中的「原点数值」（级牌还原为原点数，2 还原为 2，A 为 14）
function sequenceValue(card) {
  if (card.isJoker) return null; // 王不能进顺子
  return BASE_VALUES[card.rank];
}

// ============ 牌型分析（含逢人配） ============
// 返回 { type, mainValue, length, isBomb, bombLevel } 或 null
function analyzeCards(cards, level) {
  if (!cards || cards.length === 0) return null;
  const n = cards.length;

  const jokers = cards.filter(c => c.isJoker);
  const wilds = cards.filter(c => isWildcard(c, level));
  const normalCards = cards.filter(c => !c.isJoker);

  // 四王炸
  if (n === 4 && jokers.length === 4) {
    const reds = jokers.filter(j => j.jokerType === 'red').length;
    const blacks = jokers.filter(j => j.jokerType === 'black').length;
    if (reds === 2 && blacks === 2) {
      return { type: 'joker_bomb', mainValue: 100, length: 4, isBomb: true, bombLevel: 4 };
    }
  }

  // 含王的非四王炸牌型：王只能单独出或与同类王配对（黑王+红王不算对）
  // 王不能进顺子/连对/钢板，但可以形成"对子"（两张小王 或 两张大王）
  if (jokers.length > 0 && jokers.length < 4) {
    // 单张王
    if (n === 1) {
      return { type: 'single', mainValue: singleCompareValue(cards[0], level), length: 1, isBomb: false };
    }
    // 两张同类型王 = 对子
    if (n === 2 && jokers.length === 2) {
      const t0 = jokers[0].jokerType, t1 = jokers[1].jokerType;
      if (t0 === t1) {
        return { type: 'pair', mainValue: singleCompareValue(jokers[0], level), length: 2, isBomb: false };
      }
      return null; // 黑王+红王不算对
    }
    // 王与其他牌混合，除四王炸外不合法
    return null;
  }

  // 无王，纯普通牌（可能含逢人配）
  // 单张：逢人配单独出按级牌本身，不发挥万能效果
  if (n === 1) {
    return { type: 'single', mainValue: singleCompareValue(cards[0], level), length: 1, isBomb: false };
  }

  // 逢人配处理：尝试用红桃级牌替代，枚举所有可能
  if (wilds.length > 0) {
    return analyzeWithWildcards(cards, level, wilds, normalCards);
  }

  // 无王无逢人配：直接分析
  return analyzePlain(normalCards, level);
}

// 分析不含王、不含逢人配的纯牌
function analyzePlain(cards, level) {
  const n = cards.length;

  // 单张
  if (n === 1) return { type: 'single', mainValue: singleCompareValue(cards[0], level), length: 1, isBomb: false };

  // 对子
  if (n === 2 && sameBaseRank(cards)) {
    return { type: 'pair', mainValue: singleCompareValue(cards[0], level), length: 2, isBomb: false };
  }

  // 三张
  if (n === 3 && sameBaseRank(cards)) {
    return { type: 'trio', mainValue: singleCompareValue(cards[0], level), length: 3, isBomb: false };
  }

  // 三带二
  if (n === 5) {
    const groups = groupByBaseRank(cards);
    const counts = Object.values(groups).map(g => g.length).sort((a, b) => a - b);
    if (counts.length === 2 && counts[0] === 2 && counts[1] === 3) {
      const trioRank = Object.keys(groups).find(k => groups[k].length === 3);
      return { type: 'trio_pair', mainValue: singleCompareValue(groups[trioRank][0], level), length: 5, isBomb: false };
    }
  }

  // 同花顺（炸弹级，先于顺子）
  if (n === 5 && sameSuit(cards) && isStraight(cards, level)) {
    return { type: 'straight_flush', mainValue: straightMainValue(cards, level), length: 5, isBomb: true, bombLevel: 2 };
  }

  // 顺子（仅5张）
  if (n === 5 && isStraight(cards, level)) {
    return { type: 'straight', mainValue: straightMainValue(cards, level), length: 5, isBomb: false };
  }

  // 三连对（3对连续）
  if (n === 6 && isPairStraight(cards, level)) {
    return { type: 'pair_straight', mainValue: pairStraightMainValue(cards, level), length: 6, isBomb: false };
  }

  // 钢板（2个连续三张 = 6张）
  if (n === 6 && isTrioStraight(cards, level)) {
    return { type: 'trio_straight', mainValue: trioStraightMainValue(cards, level), length: 6, isBomb: false };
  }

  // 炸弹（4张及以上同点数，不含逢人配时点数必须完全相同）
  if (n >= 4 && sameBaseRank(cards)) {
    const bombLevel = getBombLevel(n);
    return { type: 'bomb', mainValue: singleCompareValue(cards[0], level), length: n, isBomb: true, bombLevel };
  }

  return null;
}

// 含逢人配的分析：枚举逢人配替代，找出合法牌型
function analyzeWithWildcards(cards, level, wilds, normalCards) {
  const n = cards.length;
  const normal = normalCards.filter(c => !isWildcard(c, level)); // 非逢人配的普通牌
  const normalRanks = normal.map(c => c.rank);

  // 收集普通牌中可用的目标点数（用于逢人配替代），排除王
  const distinctRanks = [...new Set(normalRanks)];
  // 也允许逢人配替代成任何点数（包括手牌中没有的点数，如凑顺子）
  const allRanks = ['2','3','4','5','6','7','8','9','10','J','Q','K','A'];

  // 尝试将每个逢人配替换为某个点数，看能否组成合法牌型
  // 简化策略：优先尝试组成「同点数炸弹」和「连续牌型」
  const candidates = [];

  // 策略1：所有牌（含逢人配替代）成为同点数 → 炸弹/三张/对子等
  // 找出普通牌的主要点数
  const rankCount = {};
  for (const r of normalRanks) rankCount[r] = (rankCount[r] || 0) + 1;
  const mainRank = Object.keys(rankCount).sort((a, b) => rankCount[b] - rankCount[a])[0];

  // 尝试所有牌都视为 mainRank
  const asBomb = tryComposeAllSame(cards, level, mainRank);
  if (asBomb) candidates.push(asBomb);

  // 策略2：逢人配补成顺子/连对/钢板
  const seqResult = tryComposeSequence(cards, level, wilds);
  if (seqResult) candidates.push(seqResult);

  // 策略3：逢人配替代为各种点数，尝试三带二
  const trioPairResult = tryComposeTrioPair(cards, level, wilds);
  if (trioPairResult) candidates.push(trioPairResult);

  // 取最优（炸弹 > 同花顺 > 其他）
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => {
    const bombRank = (x) => x.isBomb ? (x.bombLevel || 1) : 0;
    return bombRank(b) - bombRank(a);
  });
  return candidates[0];
}

// 尝试所有牌组成同点数（逢人配替代为该点数）
function tryComposeAllSame(cards, level, targetRank) {
  // 非逢人配的普通牌必须已经全部等于 targetRank 的「基础点数」（逢人配外不能有其他杂牌）
  const nonWild = cards.filter(c => !isWildcard(c, level));
  // 但王不能参与（前面已排除）
  if (nonWild.some(c => c.isJoker)) return null;
  // 所有非逢人配牌必须是 targetRank
  if (!nonWild.every(c => c.rank === targetRank)) return null;
  const n = cards.length;
  const type = n === 2 ? 'pair' : n === 3 ? 'trio' : n >= 4 ? 'bomb' : n === 1 ? 'single' : null;
  if (!type) return null;
  const mainValue = singleCompareValue(nonWild[0], level);
  if (type === 'bomb') {
    return { type, mainValue, length: n, isBomb: true, bombLevel: getBombLevel(n) };
  }
  return { type, mainValue, length: n, isBomb: false };
}

// 尝试逢人配补成顺子（5张连续）
function tryComposeSequence(cards, level, wilds) {
  const n = cards.length;
  if (n !== 5) return null;
  const nonWild = cards.filter(c => !isWildcard(c, level));
  if (nonWild.some(c => c.isJoker)) return null;
  const baseRanks = nonWild.map(c => baseValue(c.rank)).sort((a, b) => a - b);
  const wildCount = wilds.length;

  // 顺子需要 5 个连续点数，枚举可能的顺子起点
  const seqStartCandidates = [];
  // 起点范围：A低顺 A-2-3-4-5 起 1(即A当1), 或 2-3-4-5-6 起 2 ... 10-J-Q-K-A 起 10
  const starts = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]; // 1 代表 A 当 1
  for (const s of starts) {
    const seq = [s, s + 1, s + 2, s + 3, s + 4];
    // 映射回实际：A 当 1 时 seq[0]=1 → A; 否则直接对应 baseValue
    const needRanks = seq.map(v => v === 1 ? 'A' : (v >= 2 && v <= 14 ? valueToRank(v) : null));
    if (needRanks.some(r => r === null)) continue;
    // 检查非逢人配牌能否匹配，缺的用逢人配补
    const avail = baseRanks.slice();
    let wildNeeded = 0;
    for (const r of needRanks) {
      const rv = r === 'A' ? 14 : baseValue(r); // 注意 A 当 1 特殊
      // 这里 A 当 1 和 A 当 14 都要考虑
      const idx = avail.findIndex(v => v === rv || (r === 'A' && v === 14));
      if (idx >= 0) { avail.splice(idx, 1); }
      else wildNeeded++;
    }
    if (wildNeeded === wildCount && avail.length === 0) {
      // 找到合法顺子
      const mainValue = seq[4] === 1 ? 14 : (seq[4] <= 14 ? seq[4] : null);
      // 判断是否同花（逢人配补同花顺）
      const suits = nonWild.map(c => c.suit);
      const allSameSuit = suits.every(s => s === suits[0]);
      if (allSameSuit) {
        return { type: 'straight_flush', mainValue: straightValueFromSeq(seq, level), length: 5, isBomb: true, bombLevel: 2 };
      }
      return { type: 'straight', mainValue: straightValueFromSeq(seq, level), length: 5, isBomb: false };
    }
  }
  return null;
}

// 尝试逢人配补成三带二
function tryComposeTrioPair(cards, level, wilds) {
  const n = cards.length;
  if (n !== 5) return null;
  const nonWild = cards.filter(c => !isWildcard(c, level));
  if (nonWild.some(c => c.isJoker)) return null;
  const rankCount = {};
  for (const c of nonWild) rankCount[c.rank] = (rankCount[c.rank] || 0) + 1;
  const counts = Object.values(rankCount).sort((a, b) => a - b);
  const wildCount = wilds.length;
  // 需要 3+2 结构，逢人配填补缺口
  // 情况：非逢人配里已有 X 张同点 + Y 张同点，用逢人配补
  // 简化：检查能否通过逢人配凑成 3+2
  // 枚举可能的组合太多，这里做基本处理：若已有3张同点，逢人配补成对子；或已有2对，逢人配补三张
  if (counts.length <= 2 && counts.length >= 1) {
    // 尝试：选一个点数作为三张，另一个作为对子
    const ranks = Object.keys(rankCount);
    for (const trioRank of ranks) {
      const trioHave = rankCount[trioRank];
      const pairRank = ranks.find(r => r !== trioRank);
      const pairHave = pairRank ? rankCount[pairRank] : 0;
      // 用逢人配补 trio 到 3，pair 到 2
      const needTrio = Math.max(0, 3 - trioHave);
      const needPair = pairRank ? Math.max(0, 2 - pairHave) : 2;
      if (needTrio + needPair === wildCount) {
        const trioCard = nonWild.find(c => c.rank === trioRank) || { rank: trioRank };
        return { type: 'trio_pair', mainValue: singleCompareValue({ ...trioCard, rank: trioRank, isJoker: false, value: baseValue(trioRank) }, level), length: 5, isBomb: false };
      }
    }
  }
  return null;
}

function valueToRank(v) {
  for (const r in BASE_VALUES) if (BASE_VALUES[r] === v) return r;
  return null;
}

function straightValueFromSeq(seq, level) {
  // seq 最大点数（A 当 14 或 1）
  const maxV = seq[4] === 1 ? 14 : seq[4];
  // 顺子主值：用最大牌的「级牌感知」比较值
  const rank = valueToRank(maxV);
  const fakeCard = { rank, isJoker: false, value: baseValue(rank) };
  return singleCompareValue(fakeCard, level);
}

// ============ 辅助函数 ============
function sameBaseRank(cards) {
  return cards.every(c => c.rank === cards[0].rank);
}

function groupByBaseRank(cards) {
  const g = {};
  for (const c of cards) { if (!g[c.rank]) g[c.rank] = []; g[c.rank].push(c); }
  return g;
}

function sameSuit(cards) {
  if (cards.some(c => c.isJoker)) return false;
  return cards.every(c => c.suit === cards[0].suit);
}

// 顺子判断（5张连续，含 A 高低，级牌还原原点数）
function isStraight(cards, level) {
  if (cards.length !== 5) return false;
  if (cards.some(c => c.isJoker)) return false;
  const vals = cards.map(c => sequenceValue(c)).sort((a, b) => a - b);
  if (vals.some(v => v === null)) return false;
  // 常规顺子
  if (isConsecutive(vals)) return true;
  // A 低顺：A-2-3-4-5 → 1,2,3,4,5
  if (vals.join(',') === '2,3,4,5,14') {
    return true;
  }
  return false;
}

function isConsecutive(vals) {
  for (let i = 1; i < vals.length; i++) {
    if (vals[i] - vals[i - 1] !== 1) return false;
  }
  return true;
}

// 顺子主值
function straightMainValue(cards, level) {
  const vals = cards.map(c => sequenceValue(c)).sort((a, b) => a - b);
  const maxV = vals[vals.length - 1];
  // A 低顺 A-2-3-4-5 的主值是 5
  if (maxV === 14 && vals[0] === 2) return singleCompareValue({ rank: '5', isJoker: false, value: 5 }, level);
  const rank = valueToRank(maxV);
  return singleCompareValue({ rank, isJoker: false, value: maxV }, level);
}

// 三连对判断（3对连续，如 334455, QQKKAA，最小 AA2233 即 A2233? 规则说 AA2233 最小）
function isPairStraight(cards, level) {
  if (cards.length !== 6) return false;
  if (cards.some(c => c.isJoker)) return false;
  const g = groupByBaseRank(cards);
  const ranks = Object.keys(g);
  if (ranks.length !== 3) return false;
  if (!ranks.every(r => g[r].length === 2)) return false;
  // 三对点数连续
  const vals = ranks.map(r => BASE_VALUES[r]).sort((a, b) => a - b);
  // 特殊：AA2233 视为 A-2-3 连续（A 当 1）
  if (vals.join(',') === '2,3,14') return true;
  return isConsecutive(vals);
}

function pairStraightMainValue(cards, level) {
  const g = groupByBaseRank(cards);
  const vals = Object.keys(g).map(r => BASE_VALUES[r]).sort((a, b) => a - b);
  let maxV = vals[vals.length - 1];
  if (vals.join(',') === '2,3,14') maxV = 3; // AA2233 主值是 3
  const rank = valueToRank(maxV);
  return singleCompareValue({ rank, isJoker: false, value: maxV }, level);
}

// 钢板判断（2个连续三张）
function isTrioStraight(cards, level) {
  if (cards.length !== 6) return false;
  if (cards.some(c => c.isJoker)) return false;
  const g = groupByBaseRank(cards);
  const ranks = Object.keys(g);
  if (ranks.length !== 2) return false;
  if (!ranks.every(r => g[r].length === 3)) return false;
  const vals = ranks.map(r => BASE_VALUES[r]).sort((a, b) => a - b);
  return Math.abs(vals[1] - vals[0]) === 1;
}

function trioStraightMainValue(cards, level) {
  const g = groupByBaseRank(cards);
  const vals = Object.keys(g).map(r => BASE_VALUES[r]).sort((a, b) => a - b);
  const maxV = vals[vals.length - 1];
  const rank = valueToRank(maxV);
  return singleCompareValue({ rank, isJoker: false, value: maxV }, level);
}

// 炸弹层级：4张=1, 5张=2, 同花顺=3, 6张+=4, 四王炸=5
function getBombLevel(n) {
  if (n === 4) return 1;
  if (n === 5) return 2;
  return 3; // 6张及以上
}

// ============ 比较大小 ============
function canBeat(current, previous, level) {
  if (!previous) return true;
  const cur = analyzeCards(current, level);
  const prev = analyzeCards(previous, level);
  if (!cur || !prev) return false;

  // 四王炸最大
  if (cur.type === 'joker_bomb') return true;
  if (prev.type === 'joker_bomb') return false;

  // 炸弹压非炸弹
  if (cur.isBomb && !prev.isBomb) return true;
  if (prev.isBomb && !cur.isBomb) return false;

  // 都是炸弹：按层级比较
  if (cur.isBomb && prev.isBomb) {
    const cl = bombCompareLevel(cur);
    const pl = bombCompareLevel(prev);
    if (cl !== pl) return cl > pl;
    // 同层级比点数
    if (cur.mainValue !== prev.mainValue) return cur.mainValue > prev.mainValue;
    return cur.length > prev.length;
  }

  // 普通牌型：同类型同张数比主值
  if (cur.type === prev.type && cur.length === prev.length) {
    return cur.mainValue > prev.mainValue;
  }
  return false;
}

// 炸弹比较层级（严格排序）：
// 4张炸弹(1) < 5张炸弹(2) < 同花顺(3) < 6张及以上炸弹(4) < 四王炸(5)
function bombCompareLevel(analysis) {
  if (analysis.type === 'joker_bomb') return 5;
  if (analysis.type === 'straight_flush') return 3;
  if (analysis.type === 'bomb') {
    if (analysis.length >= 6) return 4;
    if (analysis.length === 5) return 2;
    return 1; // 4张
  }
  return 0;
}

// 牌的图片文件名
const RANK_IMAGE_NAME = {
  'J': 'jack', 'Q': 'queen', 'K': 'king', 'A': 'ace',
};
function cardImage(card) {
  if (card.isJoker) {
    return card.jokerType === 'red' ? 'red joker.png' : 'black joker.png';
  }
  const name = RANK_IMAGE_NAME[card.rank] || card.rank;
  return `${name} of ${card.suit}.png`;
}

function cardImagePath(card) {
  const name = cardImage(card);
  if (card.isJoker) return `image/jokers/${name}`;
  return `image/${card.suit}/${name}`;
}

module.exports = {
  SUITS, SUIT_CN, createDeck, shuffle, rankValue, baseValue,
  cardImage, cardImagePath, analyzeCards, singleCompareValue,
  isLevelCard, isWildcard, isHeartLevel, canBeat,
  LEVEL_SEQUENCE, RANK_VALUES, BASE_VALUES,
  getBombLevel, bombCompareLevel,
};

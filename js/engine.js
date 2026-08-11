/**
 * engine.js — 純粋なゲームロジック（ルール v0.2）
 *
 * 【不可逆制約】詳細は CLAUDE.md
 *   - DOM / window / document に一切触らない。Node 単体で実行できること
 *   - (state, action) => newState の純粋関数。既存 state を破壊的に変更しない
 *   - action は JSON 化可能なオブジェクトのみ
 *   - filterStateFor(state, playerId) で相手の手札とデッキの中身を落とす
 *   - 乱数は下記 seeded RNG のみ。Math.random() 禁止
 *   - 数値・効果・ルールフラグは data/cards.json。ここにベタ書きしない
 *
 * 【一貫法則】自分の手を離れたカードは、すべて相手の資源になる。例外なし。
 */

// ===========================================================================
// seeded RNG — 状態は state の一部として持ち回る
// ===========================================================================

export function createRng(seed) {
  return { s: seed >>> 0 };
}

export function nextRandom(rng) {
  const t = (rng.s + 0x6d2b79f5) >>> 0;
  let x = t;
  x = Math.imul(x ^ (x >>> 15), x | 1);
  x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
  const value = ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  return { rng: { s: t }, value };
}

export function shuffle(items, rng) {
  const out = items.slice();
  let r = rng;
  for (let i = out.length - 1; i > 0; i--) {
    const d = nextRandom(r);
    r = d.rng;
    const j = Math.floor(d.value * (i + 1));
    const tmp = out[i];
    out[i] = out[j];
    out[j] = tmp;
  }
  return { rng: r, items: out };
}

// ===========================================================================
// 定数・小道具
// ===========================================================================

export const PLAYERS = ['p1', 'p2'];

/** 相手の id */
export function opponentOf(playerId) {
  return playerId === 'p1' ? 'p2' : 'p1';
}

export function slotIndex(row, col, rules) {
  return row * rules.board.cols + col;
}

export function slotRowCol(slot, rules) {
  return { row: Math.floor(slot / rules.board.cols), col: slot % rules.board.cols };
}

export function boardSize(rules) {
  return rules.board.cols * rules.board.rows;
}

// ===========================================================================
// state の読み取りヘルパ（view はルール判定をここに委ねる）
// ===========================================================================

/** インスタンスの静的定義（cards.json 由来）を引く */
export function defOf(state, iid) {
  const inst = state.cards[iid];
  if (!inst) return null;
  return state.defs[inst.cardId] || null;
}

/** 残り体力。体力は回復しないので damage は減らない */
export function healthLeft(state, iid) {
  const inst = state.cards[iid];
  const def = defOf(state, iid);
  if (!inst || !def) return 0;
  return def.health - inst.damage;
}

/**
 * 召喚元にできる墓地の持ち主を返す。
 * 正本が矛盾しているためフラグ化してある（rules.summonSource）。view は必ずこれに従う。
 */
export function summonSourceOwner(state, playerId) {
  return state.rules.summonSource === 'ownGraveyard' ? playerId : opponentOf(playerId);
}

/** 墓地のコスト合計（表示専用。ゲーム効果は持たせない） */
export function graveyardCostTotal(state, playerId) {
  return state.players[playerId].graveyard.reduce(
    (sum, iid) => sum + (defOf(state, iid)?.cost || 0),
    0
  );
}

/** そのスロットのユニットが攻撃対象になれるか（前列が残る間、同列後列は守られる） */
export function isAttackable(state, defenderId, slot) {
  const rules = state.rules;
  const board = state.players[defenderId].board;
  if (!board[slot]) return false;
  if (!rules.backRowProtectedByFront) return true;
  const { row, col } = slotRowCol(slot, rules);
  if (row === 0) return true;
  // 後列: 同じ列の前列が空いていれば攻撃可
  return !board[slotIndex(0, col, rules)];
}

/** ネクロマンサー本体を攻撃できるか（仮ルール。rules でフラグ化） */
export function isNecromancerAttackable(state, defenderId) {
  if (!state.rules.necromancerProtectedWhileBoardOccupied) return true;
  return state.players[defenderId].board.every((s) => s === null);
}

/** attackerSlot から取れる攻撃対象の一覧 */
export function legalAttackTargets(state, playerId, attackerSlot) {
  const out = [];
  if (state.winner) return out;
  if (state.active !== playerId) return out;
  const attackerIid = state.players[playerId].board[attackerSlot];
  if (!attackerIid) return out;
  const inst = state.cards[attackerIid];
  if (inst.attacksUsed >= state.rules.attacksPerUnitPerTurn) return out;
  if (state.rules.summoningSickness && inst.summonedTurn === state.turn) return out;
  if ((defOf(state, attackerIid)?.attack || 0) <= 0) return out;

  const foe = opponentOf(playerId);
  for (let s = 0; s < boardSize(state.rules); s++) {
    if (isAttackable(state, foe, s)) out.push({ kind: 'unit', slot: s });
  }
  if (isNecromancerAttackable(state, foe)) out.push({ kind: 'necromancer' });
  return out;
}

/**
 * 召喚（ピッチコスト制）の可否を判定する。
 * @returns {{ok: boolean, reason: string, points: number, need: number}}
 */
export function canSummon(state, playerId, pitch, plays) {
  const fail = (reason, points = 0, need = 0) => ({ ok: false, reason, points, need });
  if (state.winner) return fail('決着済み');
  if (state.active !== playerId) return fail('手番ではない');

  const me = state.players[playerId];
  const src = summonSourceOwner(state, playerId);

  const pitchList = pitch || [];
  const playList = plays || [];

  // ピッチは自分の手札からのみ。重複不可
  const seenPitch = new Set();
  for (const iid of pitchList) {
    if (seenPitch.has(iid)) return fail('同じカードを二重にピッチしている');
    seenPitch.add(iid);
    if (!me.hand.includes(iid)) return fail('ピッチ対象が手札にない');
  }

  const points = pitchList.reduce((sum, iid) => sum + (defOf(state, iid)?.cost || 0), 0);
  const need = playList.reduce((sum, p) => sum + (defOf(state, p.iid)?.cost || 0), 0);

  if (playList.length === 0) return fail('召喚するカードが選ばれていない', points, need);

  const emptySlots = [];
  for (let s = 0; s < boardSize(state.rules); s++) if (!me.board[s]) emptySlots.push(s);

  const usedSlots = new Set();
  const seenPlay = new Set();
  for (const p of playList) {
    if (seenPlay.has(p.iid)) return fail('同じカードを二重に召喚している', points, need);
    seenPlay.add(p.iid);

    if (usedSlots.has(p.slot)) return fail('同じ枠に複数出そうとしている', points, need);
    if (!emptySlots.includes(p.slot)) return fail('空き枠ではない', points, need);
    usedSlots.add(p.slot);

    if (p.from === 'hand') {
      if (!me.hand.includes(p.iid)) return fail('召喚元が手札にない', points, need);
      if (seenPitch.has(p.iid)) return fail('ピッチしたカードは召喚できない', points, need);
    } else if (p.from === 'graveyard') {
      // 召喚元の墓地は rules.summonSource で決まる。
      // snapshot が有効なら判定は「ピッチ前」の墓地に対して行う。
      // 無効にすると、捨てた自分のカードを同一 action 内で出し直せてしまう。
      const pool = state.rules.summonSourcesSnapshotBeforePitch
        ? state.players[src].graveyard
        : [...state.players[src].graveyard, ...(src === opponentOf(playerId) ? pitchList : [])];
      if (!pool.includes(p.iid)) {
        return fail('召喚元の墓地にない', points, need);
      }
    } else {
      return fail('召喚元の指定が不正', points, need);
    }
  }

  if (need > points) return fail('支払いポイントが足りない', points, need);
  return { ok: true, reason: '', points, need };
}

/** 配置換えの可否 */
export function canReposition(state, playerId, fromSlot, toSlot) {
  if (state.winner) return { ok: false, reason: '決着済み' };
  if (state.active !== playerId) return { ok: false, reason: '手番ではない' };
  const me = state.players[playerId];
  if (fromSlot === toSlot) return { ok: false, reason: '移動先が同じ' };
  if (!me.board[fromSlot]) return { ok: false, reason: '移動元が空' };
  const limit = state.rules.repositionPerTurn;
  if (limit !== null && me.repositionsUsed >= limit) {
    return { ok: false, reason: 'このターンの配置換え回数を使い切っている' };
  }
  return { ok: true, reason: '' };
}

/**
 * 現在の state でそのプレイヤーが取れる action を列挙する。
 * 召喚は組み合わせ爆発するため含めない（canSummon を使うこと）。
 */
export function legalActions(state, playerId) {
  const out = [];
  if (state.winner || state.active !== playerId) return out;
  const me = state.players[playerId];

  if (!me.drawUsed && !(state.turn === 1 && !state.rules.firstPlayerDrawsOnTurn1)) {
    out.push({ type: 'draw' });
  }
  for (let s = 0; s < boardSize(state.rules); s++) {
    for (const t of legalAttackTargets(state, playerId, s)) {
      out.push({ type: 'attack', attackerSlot: s, target: t });
    }
  }
  for (let from = 0; from < boardSize(state.rules); from++) {
    if (!me.board[from]) continue;
    for (let to = 0; to < boardSize(state.rules); to++) {
      if (canReposition(state, playerId, from, to).ok) {
        out.push({ type: 'reposition', fromSlot: from, toSlot: to });
      }
    }
  }
  out.push({ type: 'endTurn' });
  return out;
}

// ===========================================================================
// 初期化
// ===========================================================================

/**
 * 初期 state を作る。
 * @param {number} seed 乱数シード
 * @param {object} cardData data/cards.json の内容
 * @param {object} [options] { first: 'p1'|'p2', names: {p1, p2}, deckList: 'default' }
 */
export function createInitialState(seed, cardData, options = {}) {
  const rules = cardData.rules;
  const first = options.first || 'p1';
  const second = opponentOf(first);
  const listName = options.deckList || 'default';
  const list = cardData.deck.lists[listName];
  if (!list) throw new Error(`デッキリストが見つからない: ${listName}`);

  // 静的定義を state に取り込む（state を自己完結・シリアライズ可能にするため）
  const defs = {};
  for (const c of cardData.cards) defs[c.id] = c;
  defs[cardData.necromancer.id] = cardData.necromancer;

  const cards = {};
  let counter = 0;
  const mkInstance = (cardId, owner) => {
    const iid = `${owner}-${String(counter++).padStart(3, '0')}`;
    cards[iid] = {
      iid,
      cardId,
      owner,        // 元の持ち主。生涯変わらない（UI の「元は誰のものか」表示に使う）
      controller: owner,
      damage: 0,
      attacksUsed: 0,
      summonedTurn: 0,
    };
    return iid;
  };

  let rng = createRng(seed);
  const players = {};

  for (const pid of [first, second]) {
    const deckIids = [];
    for (const entry of list) {
      for (let i = 0; i < entry.copies; i++) deckIids.push(mkInstance(entry.cardId, pid));
    }
    const shuffled = shuffle(deckIids, rng);
    rng = shuffled.rng;

    const handSize = pid === first ? rules.openingHand.first : rules.openingHand.second;
    players[pid] = {
      id: pid,
      name: (options.names && options.names[pid]) || (pid === 'p1' ? 'プレイヤー1' : 'プレイヤー2'),
      deck: shuffled.items.slice(handSize),
      hand: shuffled.items.slice(0, handSize),
      board: new Array(boardSize(rules)).fill(null),
      graveyard: [],
      necromancer: mkInstance(cardData.necromancer.id, pid),
      drawUsed: false,
      repositionsUsed: 0,
    };
  }

  return {
    version: cardData.version,
    rules,
    defs,
    cards,
    players,
    order: [first, second],
    active: first,
    turn: 1,
    winner: null,
    rng,
    log: [`ゲーム開始（先攻: ${players[first].name}）`],
  };
}

// ===========================================================================
// reduce — (state, action) => newState
// 既存 state を破壊的に変更しない。変更部分だけを作り直す。
// ===========================================================================

export function reduce(state, action) {
  if (!action || typeof action.type !== 'string') throw new Error('action が不正');
  if (state.winner && action.type !== 'endTurn') throw new Error('決着済み');

  switch (action.type) {
    case 'draw':       return doDraw(state, action);
    case 'summon':     return doSummon(state, action);
    case 'attack':     return doAttack(state, action);
    case 'reposition': return doReposition(state, action);
    case 'endTurn':    return doEndTurn(state, action);
    default: throw new Error(`未知の action: ${action.type}`);
  }
}

/** players の一部だけ差し替えた新しい state を作る小道具 */
function withPlayers(state, patch, extra = {}) {
  const players = { ...state.players };
  for (const pid of Object.keys(patch)) {
    players[pid] = { ...players[pid], ...patch[pid] };
  }
  return { ...state, players, ...extra };
}

function pushLog(state, line) {
  return { ...state, log: [...state.log, line] };
}

function doDraw(state) {
  const pid = state.active;
  const me = state.players[pid];
  if (me.drawUsed) throw new Error('このターンは既にドロー済み');
  if (state.turn === 1 && !state.rules.firstPlayerDrawsOnTurn1 && pid === state.order[0]) {
    throw new Error('先攻1ターン目はドローできない');
  }
  const n = state.rules.drawPerTurn;
  const drawn = me.deck.slice(0, n);
  const next = withPlayers(state, {
    [pid]: {
      deck: me.deck.slice(drawn.length),
      hand: [...me.hand, ...drawn],
      drawUsed: true,
    },
  });
  return pushLog(next, `${me.name} が ${drawn.length} 枚ドロー（デッキ残 ${next.players[pid].deck.length}）`);
}

function doSummon(state, action) {
  const pid = state.active;
  const foe = opponentOf(pid);
  const check = canSummon(state, pid, action.pitch, action.plays);
  if (!check.ok) throw new Error(`召喚できない: ${check.reason}`);

  const me = state.players[pid];
  const src = summonSourceOwner(state, pid);
  const pitch = action.pitch || [];
  const plays = action.plays || [];

  const fromHand = plays.filter((p) => p.from === 'hand').map((p) => p.iid);
  const fromGrave = plays.filter((p) => p.from === 'graveyard').map((p) => p.iid);
  const removedFromHand = new Set([...pitch, ...fromHand]);
  const graveTaken = new Set(fromGrave);

  // 盤面へ配置
  const board = me.board.slice();
  const cards = { ...state.cards };
  for (const p of plays) {
    board[p.slot] = p.iid;
    cards[p.iid] = {
      ...cards[p.iid],
      controller: pid,       // owner は変えない
      attacksUsed: 0,
      summonedTurn: state.turn,
    };
  }

  // 墓地の更新:
  //   - 召喚元の墓地から、出したカードを取り除く
  //   - ピッチしたカードは必ず「相手の」墓地へ（自分の手を離れたものは相手の資源になる）
  const graveyards = {
    [foe]: state.players[foe].graveyard,
    [pid]: state.players[pid].graveyard,
  };
  graveyards[src] = graveyards[src].filter((iid) => !graveTaken.has(iid));
  graveyards[foe] = [...graveyards[foe], ...pitch];

  const next = withPlayers(
    state,
    {
      [pid]: {
        hand: me.hand.filter((iid) => !removedFromHand.has(iid)),
        board,
        graveyard: graveyards[pid],
      },
      [foe]: { graveyard: graveyards[foe] },
    },
    { cards }
  );

  const names = plays.map((p) => defOf(state, p.iid)?.name).join('・');
  const detail = pitch.length
    ? `${pitch.length}枚ピッチ(${check.points}pt)`
    : 'ピッチなし(0pt)';
  return pushLog(next, `${me.name} が ${detail} → ${names} を召喚`);
}

function doAttack(state, action) {
  const pid = state.active;
  const foe = opponentOf(pid);
  const targets = legalAttackTargets(state, pid, action.attackerSlot);
  const ok = targets.some(
    (t) => t.kind === action.target?.kind && t.slot === action.target?.slot
  );
  if (!ok) throw new Error('その攻撃は行えない');

  const me = state.players[pid];
  const op = state.players[foe];
  const attackerIid = me.board[action.attackerSlot];
  const atkDef = defOf(state, attackerIid);

  const cards = { ...state.cards };
  cards[attackerIid] = { ...cards[attackerIid], attacksUsed: cards[attackerIid].attacksUsed + 1 };

  // --- ネクロマンサーへの攻撃 ---
  if (action.target.kind === 'necromancer') {
    const necroIid = op.necromancer;
    cards[necroIid] = { ...cards[necroIid], damage: cards[necroIid].damage + atkDef.attack };
    const necroDef = state.defs[cards[necroIid].cardId];
    const dead = necroDef.health - cards[necroIid].damage <= 0;
    const next = { ...state, cards };
    const logged = pushLog(
      next,
      `${me.name} の ${atkDef.name} が ${op.name} のネクロマンサーを攻撃（${atkDef.attack}ダメージ）`
    );
    if (dead) return pushLog({ ...logged, winner: pid }, `${op.name} のネクロマンサーが倒れた。${me.name} の勝利`);
    return logged;
  }

  // --- ユニット同士の戦闘（相打ちあり） ---
  const defenderIid = op.board[action.target.slot];
  const defDef = defOf(state, defenderIid);

  cards[defenderIid] = { ...cards[defenderIid], damage: cards[defenderIid].damage + atkDef.attack };
  cards[attackerIid] = { ...cards[attackerIid], damage: cards[attackerIid].damage + defDef.attack };

  const defenderDead = defDef.health - cards[defenderIid].damage <= 0;
  const attackerDead = atkDef.health - cards[attackerIid].damage <= 0;

  const myBoard = me.board.slice();
  const opBoard = op.board.slice();
  let myGrave = me.graveyard;
  let opGrave = op.graveyard;

  // 倒したカードは「倒した側」の墓地へ = 死んだカードは controller の相手の墓地へ
  if (defenderDead) {
    opBoard[action.target.slot] = null;
    myGrave = [...myGrave, defenderIid];
    cards[defenderIid] = { ...cards[defenderIid], damage: 0, controller: pid, attacksUsed: 0 };
  }
  if (attackerDead) {
    myBoard[action.attackerSlot] = null;
    opGrave = [...opGrave, attackerIid];
    cards[attackerIid] = { ...cards[attackerIid], damage: 0, controller: foe, attacksUsed: 0 };
  }

  const next = withPlayers(
    state,
    {
      [pid]: { board: myBoard, graveyard: myGrave },
      [foe]: { board: opBoard, graveyard: opGrave },
    },
    { cards }
  );

  let line = `${me.name} の ${atkDef.name} が ${defDef.name} を攻撃`;
  if (defenderDead && attackerDead) line += `（相打ち）`;
  else if (defenderDead) line += `（${defDef.name} を撃破 → ${me.name} の墓地へ）`;
  else if (attackerDead) line += `（${atkDef.name} が返り討ち → ${op.name} の墓地へ）`;
  return pushLog(next, line);
}

function doReposition(state, action) {
  const pid = state.active;
  const check = canReposition(state, pid, action.fromSlot, action.toSlot);
  if (!check.ok) throw new Error(`配置換えできない: ${check.reason}`);

  const me = state.players[pid];
  const cost = state.rules.repositionCost;
  const pitch = action.pitch || [];

  let hand = me.hand;
  let opGrave = state.players[opponentOf(pid)].graveyard;
  if (cost > 0) {
    const points = pitch.reduce((s, iid) => s + (defOf(state, iid)?.cost || 0), 0);
    for (const iid of pitch) if (!me.hand.includes(iid)) throw new Error('ピッチ対象が手札にない');
    if (points < cost) throw new Error('配置換えの支払いが足りない');
    const set = new Set(pitch);
    hand = me.hand.filter((iid) => !set.has(iid));
    opGrave = [...opGrave, ...pitch];
  }

  const board = me.board.slice();
  const moved = board[action.fromSlot];
  board[action.fromSlot] = board[action.toSlot]; // 空きなら null、ユニットなら入れ替え
  board[action.toSlot] = moved;

  const patch = {
    [pid]: { board, hand, repositionsUsed: me.repositionsUsed + 1 },
  };
  if (cost > 0) patch[opponentOf(pid)] = { graveyard: opGrave };

  const next = withPlayers(state, patch);
  return pushLog(next, `${me.name} が ${defOf(state, moved)?.name} を配置換え`);
}

function doEndTurn(state) {
  if (state.winner) return state;
  const nextPid = opponentOf(state.active);
  const nx = state.players[nextPid];

  // 手番が始まる側のフラグをリセット
  const cards = { ...state.cards };
  for (const iid of nx.board) {
    if (iid) cards[iid] = { ...cards[iid], attacksUsed: 0 };
  }

  const next = withPlayers(
    state,
    { [nextPid]: { drawUsed: false, repositionsUsed: 0 } },
    { cards, active: nextPid, turn: state.turn + 1 }
  );
  return pushLog(next, `--- ターン ${next.turn}: ${nx.name} ---`);
}

// ===========================================================================
// filterStateFor — 特定プレイヤー視点の state
//
// 権威サーバ型では、サーバがクライアントへ返す前に必ずこれを通す。
// 相手の手札とデッキの中身は必ず落とす（枚数のみ）。
// ===========================================================================

export function filterStateFor(state, playerId) {
  const foe = opponentOf(playerId);

  // 見えてよいインスタンスだけを集める:
  //   自分の手札 / 両者の盤面 / 両者の墓地 / 両者のネクロマンサー
  // デッキの中身は自分のものも含めて一切見せない（先読み防止）。
  const visible = new Set();
  for (const iid of state.players[playerId].hand) visible.add(iid);
  for (const pid of PLAYERS) {
    const p = state.players[pid];
    for (const iid of p.board) if (iid) visible.add(iid);
    for (const iid of p.graveyard) visible.add(iid);
    visible.add(p.necromancer);
  }

  const cards = {};
  for (const iid of visible) cards[iid] = state.cards[iid];

  const players = {};
  for (const pid of PLAYERS) {
    const p = state.players[pid];
    const mine = pid === playerId;
    players[pid] = {
      id: p.id,
      name: p.name,
      hand: mine ? p.hand : null,     // 相手の手札は中身を落とす
      handCount: p.hand.length,
      deckCount: p.deck.length,       // デッキは両者とも枚数のみ
      board: p.board,
      graveyard: p.graveyard,
      graveyardCost: graveyardCostTotal(state, pid),
      necromancer: p.necromancer,
      drawUsed: p.drawUsed,
      repositionsUsed: p.repositionsUsed,
    };
  }

  return {
    version: state.version,
    rules: state.rules,
    defs: state.defs,
    cards,
    players,
    order: state.order,
    active: state.active,
    turn: state.turn,
    winner: state.winner,
    log: state.log,
    you: playerId,
    // rng は丸ごと落とす（デッキ順の先読みを防ぐ）
  };
}

// ===========================================================================
// Node 単体実行時のセルフテスト
//   $ node js/engine.js
// ブラウザではこのブロックは評価されない。
// ===========================================================================

const isNodeMain =
  typeof process !== 'undefined' &&
  !!process.versions?.node &&
  typeof process.argv?.[1] === 'string' &&
  /engine\.js$/.test(process.argv[1]);

if (isNodeMain) {
  const { readFileSync } = await import('node:fs');
  const { fileURLToPath } = await import('node:url');
  const path = await import('node:path');

  const here = path.dirname(fileURLToPath(import.meta.url));
  const cardData = JSON.parse(readFileSync(path.join(here, '..', 'data', 'cards.json'), 'utf8'));

  let failures = 0;
  let checks = 0;
  const check = (label, cond) => {
    checks++;
    if (cond) {
      console.log(`  ok   ${label}`);
    } else {
      console.log(`  FAIL ${label}`);
      failures++;
    }
  };

  /** 決定的な簡易 AI。同一シードなら常に同じ手を選ぶ */
  function autoAction(state) {
    const pid = state.active;
    const me = state.players[pid];
    if (!me.drawUsed) return { type: 'draw' };

    // 攻撃できるなら攻撃（ネクロマンサーを優先）
    for (let s = 0; s < boardSize(state.rules); s++) {
      const ts = legalAttackTargets(state, pid, s);
      const necro = ts.find((t) => t.kind === 'necromancer');
      if (necro) return { type: 'attack', attackerSlot: s, target: necro };
      if (ts.length) return { type: 'attack', attackerSlot: s, target: ts[0] };
    }

    // 召喚: 手札の最安を1枚ピッチし、その範囲で出せるものを1体出す
    const empty = [];
    for (let s = 0; s < boardSize(state.rules); s++) if (!me.board[s]) empty.push(s);
    if (empty.length && me.hand.length >= 2) {
      const byCost = me.hand.slice().sort((a, b) => {
        const d = defOf(state, a).cost - defOf(state, b).cost;
        return d !== 0 ? d : a < b ? -1 : a > b ? 1 : 0; // iid で決定的にタイブレーク
      });
      const pitchIid = byCost[byCost.length - 1]; // 高いものをピッチ
      const points = defOf(state, pitchIid).cost;
      const foeGrave = state.players[summonSourceOwner(state, pid)].graveyard;
      const candidates = [
        ...me.hand.filter((i) => i !== pitchIid).map((i) => ({ iid: i, from: 'hand' })),
        ...foeGrave.map((i) => ({ iid: i, from: 'graveyard' })),
      ].filter((c) => defOf(state, c.iid).cost <= points);
      if (candidates.length) {
        const pick = candidates[0];
        const act = { type: 'summon', pitch: [pitchIid], plays: [{ ...pick, slot: empty[0] }] };
        if (canSummon(state, pid, act.pitch, act.plays).ok) return act;
      }
    }
    return { type: 'endTurn' };
  }

  function playout(seed, maxSteps = 400, data = cardData) {
    let state = createInitialState(seed, data);
    const actions = [];
    for (let i = 0; i < maxSteps && !state.winner; i++) {
      const a = autoAction(state);
      actions.push(a);
      state = reduce(state, a);
    }
    return { state, actions };
  }

  console.log('engine.js セルフテスト（ルール v0.2）');

  // --- 1. 初期化 ---
  const s0 = createInitialState(12345, cardData);
  check('初手 先攻6枚', s0.players.p1.hand.length === cardData.rules.openingHand.first);
  check('初手 後攻7枚', s0.players.p2.hand.length === cardData.rules.openingHand.second);
  check(
    'デッキ残 = 総数 - 初手',
    s0.players.p1.deck.length === cardData.deck.size - cardData.rules.openingHand.first
  );
  check('盤面は6枠', s0.players.p1.board.length === 6);
  check('墓地は空で開始', s0.players.p1.graveyard.length === 0);

  // --- 2. 非破壊性 ---
  const before = JSON.stringify(s0);
  const s1 = reduce(s0, { type: 'draw' });
  check('reduce は元の state を変更しない', JSON.stringify(s0) === before);
  check('reduce は新しい state を返す', s1 !== s0 && s1.players.p1.hand.length === 8);

  // --- 3. 決定性 ---
  const runA = playout(999);
  const runB = playout(999);
  check('同一シード + 同一手順 → 同一結果', JSON.stringify(runA.state) === JSON.stringify(runB.state));
  const runC = playout(1000);
  check('別シード → 別の展開', JSON.stringify(runA.state) !== JSON.stringify(runC.state));

  // --- 4. Math.random 不使用（ソース検査） ---
  // 検査パターンとラベルを分割して組み立てる（このソース自身が誤検出しないように）。
  // コメントは剥がしてから検査する（規約を説明するコメントに反応させないため）。
  const banned = new RegExp(['Math', '\\.', 'random'].join(''));
  const stripComments = (t) =>
    t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  for (const rel of ['engine.js', 'view.js']) {
    const code = stripComments(readFileSync(path.join(here, rel), 'utf8'));
    check(`${rel}: ${'Math'}.random を使っていない`, !banned.test(code));
  }
  void fileURLToPath;

  // --- 5. 一貫法則: 自分のカードは自分の墓地に存在しない ---
  const end = runA.state;
  let lawHolds = true;
  for (const pid of PLAYERS) {
    for (const iid of end.players[pid].graveyard) {
      if (end.cards[iid].owner === pid) lawHolds = false;
    }
  }
  check('自分の墓地に自分のカードが存在しない（一貫法則）', lawHolds);

  // --- 6. カードの総数が保存される ---
  let total = 0;
  for (const pid of PLAYERS) {
    const p = end.players[pid];
    total += p.deck.length + p.hand.length + p.graveyard.length + p.board.filter(Boolean).length;
  }
  check('カード総数が保存されている', total === cardData.deck.size * 2);

  // --- 7. filterStateFor ---
  const mid = runA.state;
  const view = filterStateFor(mid, 'p1');
  check('相手の手札の中身が落ちている', view.players.p2.hand === null);
  check('相手の手札の枚数は見える', view.players.p2.handCount === mid.players.p2.hand.length);
  check('デッキは枚数のみ', view.players.p1.deck === undefined && typeof view.players.p1.deckCount === 'number');
  check('rng が落ちている', view.rng === undefined);

  const leaked = mid.players.p2.hand.filter((iid) => view.cards[iid] !== undefined);
  check('相手の手札のカード実体が漏れていない', leaked.length === 0);
  const deckLeak = [...mid.players.p1.deck, ...mid.players.p2.deck].filter(
    (iid) => view.cards[iid] !== undefined
  );
  check('デッキのカード実体が漏れていない', deckLeak.length === 0);
  check('自分の墓地は見える', view.players.p1.graveyard.length === mid.players.p1.graveyard.length);
  check('墓地の総コストが出ている', typeof view.players.p1.graveyardCost === 'number');

  // --- 8. 前列が後列を守る ---
  const rules = cardData.rules;
  let s = createInitialState(7, cardData);
  const iidFront = s.players.p2.hand[0];
  const iidBack = s.players.p2.hand[1];
  const board = s.players.p2.board.slice();
  board[slotIndex(0, 1, rules)] = iidFront;
  board[slotIndex(1, 1, rules)] = iidBack;
  s = { ...s, players: { ...s.players, p2: { ...s.players.p2, board } } };
  check('前列が居る間、同列の後列は攻撃されない', !isAttackable(s, 'p2', slotIndex(1, 1, rules)));
  check('前列は攻撃できる', isAttackable(s, 'p2', slotIndex(0, 1, rules)));
  const board2 = s.players.p2.board.slice();
  board2[slotIndex(0, 1, rules)] = null;
  const s2 = { ...s, players: { ...s.players, p2: { ...s.players.p2, board: board2 } } };
  check('前列が退けば後列を攻撃できる', isAttackable(s2, 'p2', slotIndex(1, 1, rules)));
  check('盤面に1体でも居ればネクロマンサーは攻撃できない', !isNecromancerAttackable(s, 'p2'));

  // --- 9. ピッチしたカードを同一 action で召喚し直せない ---
  let s3 = createInitialState(31, cardData);
  const h = s3.players.p1.hand;
  const bad = canSummon(s3, 'p1', [h[0]], [{ iid: h[0], from: 'hand', slot: 0 }]);
  check('ピッチしたカードは同じ action で召喚できない', !bad.ok);

  // --- 10. 召喚元フラグ（正本の矛盾に対応する両方の読みが動くこと） ---
  for (const mode of ['opponentGraveyard', 'ownGraveyard']) {
    const data = { ...cardData, rules: { ...cardData.rules, summonSource: mode } };
    const r = playout(2024, 400, data);
    check(`summonSource=${mode} で最後まで進行する`, r.state.turn > 1);
    let ok = true;
    for (const pid of PLAYERS) {
      for (const iid of r.state.players[pid].graveyard) {
        if (r.state.cards[iid].owner === pid) ok = false;
      }
    }
    check(`summonSource=${mode} でも一貫法則が保たれる`, ok);
  }

  // --- 11. 決着 ---
  check('決着まで到達した（勝者あり）', end.winner !== null);

  console.log(
    failures === 0
      ? `\n${checks} 件すべて成功`
      : `\n${checks} 件中 ${failures} 件失敗`
  );
  if (failures > 0) process.exit(1);
}

/**
 * engine.js — 純粋なゲームロジック（ルール v0.2）
 *
 * 【不可逆制約】詳細は CLAUDE.md
 *   - DOM / window / document に一切触らない。Node 単体で実行できること
 *   - (state, action) => newState の純粋関数。既存 state を破壊的に変更しない
 *   - action は JSON 化可能なオブジェクトのみ
 *   - filterStateFor(state, playerId) で相手の手札とデッキの中身を落とす
 *   - 乱数は下記 seeded RNG のみ。Math.random() 禁止
 *   - 数値・効果・ルールフラグは data/cards.js。ここにベタ書きしない
 *
 * 【一貫法則】自分の手を離れたカードは、すべて相手の資源になる。例外なし。
 *
 * 【読み込み形式】CG-008
 *   ES モジュールは file:// から読めない（作者は index.html をダブルクリックで開く）。
 *   そのため全体を即時関数で包み、
 *     - ブラウザ … 素の <script> で読み、グローバル NECRO_ENGINE に入る
 *     - Node    … require('./engine.js') で同じものが返る
 *   の両対応にしてある。この外側の包みを外さないこと。
 */

(function (root) {
'use strict';

// ===========================================================================
// seeded RNG — 状態は state の一部として持ち回る
// ===========================================================================

function createRng(seed) {
  return { s: seed >>> 0 };
}

function nextRandom(rng) {
  const t = (rng.s + 0x6d2b79f5) >>> 0;
  let x = t;
  x = Math.imul(x ^ (x >>> 15), x | 1);
  x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
  const value = ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  return { rng: { s: t }, value };
}

function shuffle(items, rng) {
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

const PLAYERS = ['p1', 'p2'];

/** 相手の id */
function opponentOf(playerId) {
  return playerId === 'p1' ? 'p2' : 'p1';
}

function slotIndex(row, col, rules) {
  return row * rules.board.cols + col;
}

function slotRowCol(slot, rules) {
  return { row: Math.floor(slot / rules.board.cols), col: slot % rules.board.cols };
}

function boardSize(rules) {
  return rules.board.cols * rules.board.rows;
}

// ===========================================================================
// state の読み取りヘルパ（view はルール判定をここに委ねる）
// ===========================================================================

/** インスタンスの静的定義（cards.js 由来）を引く */
function defOf(state, iid) {
  const inst = state.cards[iid];
  if (!inst) return null;
  return state.defs[inst.cardId] || null;
}

/**
 * 能力による数値の上書きを見てから静的定義に落ちる。
 * `inst.stats` は c05 の「1/1 になって後列へ移動する」のように、
 * 場に居る間だけ数値が変わる能力のために置く。値は必ず cards.js 由来。
 */
function statValue(defs, cards, iid, key) {
  const inst = cards[iid];
  if (!inst) return 0;
  if (inst.stats && typeof inst.stats[key] === 'number') return inst.stats[key];
  const def = defs[inst.cardId];
  return def ? def[key] : 0;
}

/** 現在の攻撃力（能力で書き換えられていればその値） */
function attackOf(state, iid) {
  return statValue(state.defs, state.cards, iid, 'attack');
}

/** 現在の最大体力（能力で書き換えられていればその値） */
function healthOf(state, iid) {
  return statValue(state.defs, state.cards, iid, 'health');
}

/** 残り体力。体力は回復しないので damage は減らない */
function healthLeft(state, iid) {
  const inst = state.cards[iid];
  if (!inst) return 0;
  return healthOf(state, iid) - inst.damage;
}

/** そのインスタンスの能力定義（なければ null） */
function abilityOf(state, iid) {
  return defOf(state, iid)?.ability || null;
}

/**
 * 召喚元にできる墓地の持ち主を返す。
 * 既定は自分の墓地（rules.summonSource = 'ownGraveyard'）。
 * 自分の墓地にあるのは「自分が倒した相手のカード」と「相手が支払いで捨てたカード」だけなので、
 * 墓地からの召喚は常に「奪ったものを使役する」行為になる。view は必ずこれに従う。
 */
function summonSourceOwner(state, playerId) {
  return state.rules.summonSource === 'ownGraveyard' ? playerId : opponentOf(playerId);
}

/** 墓地のコスト合計（表示専用。ゲーム効果は持たせない） */
function graveyardCostTotal(state, playerId) {
  return state.players[playerId].graveyard.reduce(
    (sum, iid) => sum + (defOf(state, iid)?.cost || 0),
    0
  );
}

/**
 * 呪い（c08）による、墓地からの召喚への追加支払い。
 *
 * 呪いは「相手の墓地にある間」効く。一貫法則により、自分の墓地にあるのは
 * 必ず相手が持ち主のカードなので、判定は「playerId 自身の墓地」を見るだけでよい。
 * まだ発動していない（`curseArmed !== false`）呪いだけを数える。
 *
 * 積み方は `rules.abilities.curseStacking` で切り替える:
 *   'add'   … 複数枚あれば加算し、その召喚で全部まとめて発動する（既定）
 *   'first' … 何枚あっても1枚分だけ発動する
 */
function graveyardSummonTax(state, playerId) {
  const mode = state.rules.abilities?.curseStacking || 'add';
  let tax = 0;
  for (const iid of state.players[playerId].graveyard) {
    const ab = abilityOf(state, iid);
    if (!ab || ab.effect !== 'graveyardSummonTax') continue;
    if (state.cards[iid].curseArmed === false) continue;
    tax += ab.params?.amount ?? 1;
    if (mode !== 'add') break;
  }
  return tax;
}

/** その召喚でいま発動する呪いのインスタンス（発動済みにする対象） */
function armedCurses(state, playerId) {
  const mode = state.rules.abilities?.curseStacking || 'add';
  const out = [];
  for (const iid of state.players[playerId].graveyard) {
    const ab = abilityOf(state, iid);
    if (!ab || ab.effect !== 'graveyardSummonTax') continue;
    if (state.cards[iid].curseArmed === false) continue;
    out.push(iid);
    if (mode !== 'add') break;
  }
  return out;
}

/** そのスロットのユニットが攻撃対象になれるか（前列が残る間、同列後列は守られる） */
function isAttackable(state, defenderId, slot) {
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
function isNecromancerAttackable(state, defenderId) {
  if (!state.rules.necromancerProtectedWhileBoardOccupied) return true;
  return state.players[defenderId].board.every((s) => s === null);
}

/** attackerSlot から取れる攻撃対象の一覧 */
function legalAttackTargets(state, playerId, attackerSlot) {
  const out = [];
  if (state.winner) return out;
  if (state.active !== playerId) return out;
  // 先攻1ターン目の攻撃制限（CG-017・rules.firstPlayerAttacksOnTurn1 = false のとき）。
  // 対象は先攻プレイヤーの最初の手番のみ。ユニットへの攻撃もネクロマンサーへの攻撃も不可。
  // 召喚・配置換えはこの関数を通らないので制限されない。
  if (
    state.rules.firstPlayerAttacksOnTurn1 === false &&
    state.turn === 1 &&
    playerId === state.order[0]
  ) {
    return out;
  }
  const attackerIid = state.players[playerId].board[attackerSlot];
  if (!attackerIid) return out;
  const inst = state.cards[attackerIid];
  if (inst.attacksUsed >= state.rules.attacksPerUnitPerTurn) return out;
  if (state.rules.summoningSickness && inst.summonedTurn === state.turn) return out;
  if (attackOf(state, attackerIid) <= 0) return out;

  const foe = opponentOf(playerId);
  for (let s = 0; s < boardSize(state.rules); s++) {
    if (isAttackable(state, foe, s)) out.push({ kind: 'unit', slot: s });
  }
  if (isNecromancerAttackable(state, foe)) out.push({ kind: 'necromancer' });
  return out;
}

/**
 * 召喚（ピッチコスト制）の可否を判定する。
 * `tax` は呪い（c08）による追加支払い。墓地から1体でも出すときだけ乗る。
 * `credit` はターン内に持ち越している pt（CG-015）。
 * `rules.pitchCarryover` が無効なら常に 0 で、支払いには数えない。
 * @returns {{ok: boolean, reason: string, points: number, need: number, tax: number, credit: number}}
 */
function canSummon(state, playerId, pitch, plays) {
  const me = state.players[playerId];
  const credit = state.rules.pitchCarryover ? me.pitchCredit || 0 : 0;
  const fail = (reason, points = 0, need = 0, tax = 0) => ({ ok: false, reason, points, need, tax, credit });
  if (state.winner) return fail('決着済み');
  if (state.active !== playerId) return fail('手番ではない');

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
      // 墓地に入りたてのカードは、rules.graveyardSummonBuffer 手番ぶん寝かせる。
      // 0 なら素通り（CG-010 までの挙動）。
      if (!graveyardReady(state, p.iid)) {
        return fail('墓地に入ったばかりで召喚できない', points, need);
      }
    } else {
      return fail('召喚元の指定が不正', points, need);
    }
  }

  // 呪い（c08）: 墓地から1体でも召喚するなら追加支払いが乗る。
  // 何体まとめて出しても、1回の召喚につき1回だけ乗る。
  // ★ 持ち越し（credit）があっても、乗る額・乗る条件は変わらない。
  //   支払える原資が「その召喚のピッチ + 持ち越し」に広がるだけ（pt の出所は問わない）。
  const usesGraveyard = playList.some((p) => p.from === 'graveyard');
  const tax = usesGraveyard ? graveyardSummonTax(state, playerId) : 0;

  if (need + tax > points + credit) {
    return fail(
      tax > 0 ? `支払いポイントが足りない（呪い +${tax}）` : '支払いポイントが足りない',
      points,
      need,
      tax
    );
  }
  return { ok: true, reason: '', points, need, tax, credit };
}

/**
 * そのカードが墓地から召喚できる状態か（寝かせ終わっているか）。
 *
 * `rules.graveyardSummonBuffer` は「墓地に入ってから必要な経過手番数」。
 *   0 … 制限なし（既定・CG-016 の裁定で確定）
 *   1 … 墓地に入ったその手番中は出せない
 *   2 … 墓地の持ち主が自分の手番を1回またぐまで出せない（CG-011〜CG-015 の既定）
 *
 * `enteredGraveyardTurn` を持たないカード（初期配置など墓地を経由していないもの）は
 * 判定対象外として通す。
 */
function graveyardReady(state, iid) {
  const buffer = state.rules.graveyardSummonBuffer || 0;
  if (buffer <= 0) return true;
  const entered = state.cards[iid]?.enteredGraveyardTurn;
  if (entered === undefined || entered === null) return true;
  return state.turn - entered >= buffer;
}

/** 配置換えの可否 */
function canReposition(state, playerId, fromSlot, toSlot) {
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
function legalActions(state, playerId) {
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
 * @param {object} cardData data/cards.js の内容
 * @param {object} [options] { first: 'p1'|'p2', names: {p1, p2}, deckList: 'default' }
 */
function createInitialState(seed, cardData, options = {}) {
  const rules = cardData.rules;
  const first = options.first || 'p1';
  const second = opponentOf(first);
  const listName = options.deckList || 'default';
  const list = cardData.deck.lists[listName];
  if (!list) throw new Error(`デッキリストが見つからない: ${listName}`);

  // 静的定義を state に取り込む（state を自己完結・シリアライズ可能にするため）
  const defs = {};
  for (const c of cardData.cards) defs[c.id] = c;
  for (const t of cardData.tokens?.list || []) defs[t.id] = t;
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
      pitchCredit: 0,   // ターン内に持ち越している pt（CG-015。rules.pitchCarryover が無効なら常に 0）
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
    // 対局中に生成されるインスタンス（トークン）の連番。
    // 乱数ではなく単調増加なので、同一 action 列なら同じ iid が振られる。
    nextInstance: counter,
    log: [`ゲーム開始（先攻: ${players[first].name}）`],
  };
}

// ===========================================================================
// reduce — (state, action) => newState
// 既存 state を破壊的に変更しない。変更部分だけを作り直す。
// ===========================================================================

function reduce(state, action) {
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

// ---------------------------------------------------------------------------
// 能力の解決に使う小道具
//
// 効果の中身は data/cards.js の ability（trigger / effect / params）で決まる。
// ここには「どの effect 名をどう処理するか」だけを書き、数値は持たない。
// ---------------------------------------------------------------------------

/**
 * 墓地へ入るときのインスタンスの姿。
 *   - 場での状態（ダメージ・攻撃済み・能力による数値の上書き）を落とす
 *   - controller をその墓地の持ち主に合わせる
 *   - 呪い（c08）は「墓地に入ってから最初の1回」を数え直すので再武装する
 */
/**
 * 墓地に入った瞬間のインスタンスを作る。**墓地へ入る経路はすべてここを通す。**
 * （戦闘での撃破 / c07 のデッキ送り / ピッチ / 配置換えの支払い）
 *
 * `turn` は「墓地に入った手番」。`rules.graveyardSummonBuffer` の判定に使う。
 * state.turn をそのまま刻むだけなので決定性には影響しない。
 */
function toGraveyardInstance(defs, inst, graveOwner, turn) {
  const next = {
    ...inst,
    controller: graveOwner,   // owner は生涯変わらない
    damage: 0,
    attacksUsed: 0,
    stats: null,
    transformed: false,
    enteredGraveyardTurn: turn,
  };
  const ab = defs[inst.cardId]?.ability;
  if (ab && ab.effect === 'graveyardSummonTax') next.curseArmed = true;
  return next;
}

/**
 * c05 の退避先。後列（最終行）の空き枠を探す。
 * `rules.abilities.deathRetreatSlotOrder`:
 *   'sameColumnFirst' … 同じ列の後列を優先し、なければ後列を左から（既定）
 *   'leftmost'        … 常に後列を左から
 * 空きがなければ null（＝退避できない）。
 */
function retreatSlotFor(rules, board, fromSlot) {
  const backRow = rules.board.rows - 1;
  const order = rules.abilities?.deathRetreatSlotOrder || 'sameColumnFirst';
  const candidates = [];
  if (order === 'sameColumnFirst') {
    const { col } = slotRowCol(fromSlot, rules);
    candidates.push(slotIndex(backRow, col, rules));
  }
  for (let c = 0; c < rules.board.cols; c++) candidates.push(slotIndex(backRow, c, rules));
  for (const s of candidates) {
    if (s !== fromSlot && !board[s]) return s;
    // 倒れた本人が後列に居た場合、その枠は空くのでそこへ「留まる」形になる
    if (s === fromSlot) return s;
  }
  return null;
}

/** 同じ行の右隣の枠。右端なら null */
function rightSlotOf(rules, slot) {
  const { row, col } = slotRowCol(slot, rules);
  if (col + 1 >= rules.board.cols) return null;
  return slotIndex(row, col + 1, rules);
}

/**
 * 倒れた1体を処理する。ctx の boards / graveyards / cards / log を差し替えていく
 * （いずれも呼び出し側が作った作業用のコピー。state は触らない）。
 *
 * @returns {'retreat'|'vanish'|'graveyard'} どの経路で処理したか
 */
function resolveDeath(ctx, iid, controllerId, slot) {
  const { rules, defs } = ctx;
  const inst = ctx.cards[iid];
  const ab = defs[inst.cardId]?.ability;
  const name = defs[inst.cardId]?.name;

  // --- c05: 倒されたとき、1/1 になって後列へ移動する ---
  if (ab && ab.effect === 'retreatToBackRow' && !inst.transformed) {
    const board = ctx.boards[controllerId];
    let dest = retreatSlotFor(rules, board, slot);
    // 後列に空きがない場合の挙動は rules.abilities.deathRetreatNoRoom で切り替える。
    // 既定は 'toGraveyard'（＝不発。通常どおり相手の墓地へ）。
    if (dest === null && rules.abilities?.deathRetreatNoRoom === 'anyEmptySlot') {
      for (let s = 0; s < board.length; s++) {
        if (!board[s]) { dest = s; break; }
      }
    }
    if (dest !== null) {
      board[slot] = null;
      board[dest] = iid;
      ctx.cards[iid] = {
        ...inst,
        damage: 0,
        attacksUsed: 0,
        stats: { attack: ab.params?.attack ?? 1, health: ab.params?.health ?? 1 },
        transformed: true,
      };
      ctx.log.push(
        `${name} は倒れたが ${ctx.names[controllerId]} の後列へ退いた（${ctx.cards[iid].stats.attack}/${ctx.cards[iid].stats.health}）`
      );
      return 'retreat';
    }
  }

  // --- 消滅: 墓地へ送らず、盤面から取り除いて終わり ---
  // 何が消滅するかは engine では決めない。カード定義側の onDeath を読むだけで、
  // 「トークンかどうか」では分岐しない（data/cards.js の tokens で切り替える）。
  // 省略時は 'toGraveyard'（＝CG-006 までの挙動）。
  if ((defs[inst.cardId]?.onDeath || 'toGraveyard') === 'vanish') {
    ctx.boards[controllerId][slot] = null;
    // どのゾーンにも属さなくなるので実体も落とす（残すと state に孤児が溜まる）。
    // iid の採番は単調増加なので、消しても決定性には影響しない。
    delete ctx.cards[iid];
    ctx.log.push(`${name} は倒れて消滅した（墓地へは行かない）`);
    return 'vanish';
  }

  // --- 通常: 倒した側（controller の相手）の墓地へ ---
  const graveOwner = opponentOf(controllerId);
  ctx.boards[controllerId][slot] = null;
  ctx.graveyards[graveOwner] = [...ctx.graveyards[graveOwner], iid];
  ctx.cards[iid] = toGraveyardInstance(defs, inst, graveOwner, ctx.turn);
  return 'graveyard';
}

/**
 * c07: 相手のカードを倒したとき、相手のデッキの一番上1枚を自分の墓地へ送る。
 * 発動条件は「killerIid が相手のカードを倒したこと」。デッキが空なら何も起きない。
 */
function resolveKillTrigger(ctx, killerIid, killerSide) {
  // 相打ちで倒した側が消滅している場合がある（onDeath: 'vanish'）。実体が無ければ何もしない
  const killer = ctx.cards[killerIid];
  if (!killer) return;
  const ab = ctx.defs[killer.cardId]?.ability;
  if (!ab || ab.effect !== 'millOpponentDeck') return;
  const foe = opponentOf(killerSide);
  const n = ab.params?.count ?? 1;
  const taken = ctx.decks[foe].slice(0, n);
  if (taken.length === 0) return;
  ctx.decks[foe] = ctx.decks[foe].slice(taken.length);
  ctx.graveyards[killerSide] = [...ctx.graveyards[killerSide], ...taken];
  for (const iid of taken) {
    ctx.cards[iid] = toGraveyardInstance(ctx.defs, ctx.cards[iid], killerSide, ctx.turn);
  }
  ctx.log.push(
    `${ctx.defs[ctx.cards[killerIid].cardId].name} の効果で ${ctx.names[foe]} のデッキ上 ${taken.length} 枚が ${ctx.names[killerSide]} の墓地へ`
  );
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
      damage: 0,
      attacksUsed: 0,
      stats: null,           // 墓地から出し直したら「刷られた数値」に戻る
      transformed: false,
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
  for (const iid of pitch) {
    cards[iid] = toGraveyardInstance(state.defs, cards[iid], foe, state.turn);
  }

  // 呪い（c08）を発動済みにする。判定は canSummon が済ませてあるので、
  // ここでは「この召喚で消費した呪い」を落とすだけ。
  const consumed = check.tax > 0 ? armedCurses(state, pid) : [];
  for (const iid of consumed) cards[iid] = { ...cards[iid], curseArmed: false };

  // --- 場に出たときの効果（c06: 右の空き枠に 1/1 のトークン） ---
  // 複数体を同時召喚したときの順番は slot 昇順に固定する（決定性のため）。
  const extraLog = [];
  let nextInstance = state.nextInstance;
  const entered = plays.slice().sort((a, b) => a.slot - b.slot);
  for (const p of entered) {
    const ab = state.defs[cards[p.iid].cardId]?.ability;
    if (!ab || ab.effect !== 'spawnTokenRight') continue;
    const right = rightSlotOf(state.rules, p.slot);
    if (right === null || board[right]) continue;   // 右端 / 埋まっている → 何も起きない
    const tokenId = ab.params?.tokenId;
    const tokenDef = state.defs[tokenId];
    if (!tokenDef) continue;
    const iid = `${pid}-t${String(nextInstance++).padStart(3, '0')}`;
    cards[iid] = {
      iid,
      cardId: tokenId,
      owner: pid,
      controller: pid,
      damage: 0,
      attacksUsed: 0,
      summonedTurn: state.turn,
      stats: null,
      transformed: false,
      token: true,
    };
    board[right] = iid;
    extraLog.push(`${state.defs[cards[p.iid].cardId].name} の効果で ${tokenDef.name} が右の枠に出た`);
  }

  // 余った pt の行き先（CG-015）。持ち越しが有効なら pitchCredit に積み、
  // 無効なら従来どおり消える（常に 0）。
  const leftover = state.rules.pitchCarryover
    ? check.points + check.credit - check.need - check.tax
    : 0;

  const next = withPlayers(
    state,
    {
      [pid]: {
        hand: me.hand.filter((iid) => !removedFromHand.has(iid)),
        board,
        graveyard: graveyards[pid],
        pitchCredit: leftover,
      },
      [foe]: { graveyard: graveyards[foe] },
    },
    { cards, nextInstance }
  );

  const names = plays.map((p) => defOf(state, p.iid)?.name).join('・');
  const detail = pitch.length
    ? `${pitch.length}枚ピッチ(${check.points}pt)`
    : 'ピッチなし(0pt)';
  const tax = check.tax > 0 ? `／呪い +${check.tax}pt` : '';
  const carry = state.rules.pitchCarryover ? `（残り ${leftover}pt を持ち越し）` : '';
  let out = pushLog(next, `${me.name} が ${detail}${tax} → ${names} を召喚${carry}`);
  for (const line of extraLog) out = pushLog(out, line);
  return out;
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
  const atkName = defOf(state, attackerIid).name;
  const atkPower = attackOf(state, attackerIid);

  const cards = { ...state.cards };
  cards[attackerIid] = { ...cards[attackerIid], attacksUsed: cards[attackerIid].attacksUsed + 1 };

  // --- ネクロマンサーへの攻撃 ---
  if (action.target.kind === 'necromancer') {
    const necroIid = op.necromancer;
    cards[necroIid] = { ...cards[necroIid], damage: cards[necroIid].damage + atkPower };
    const dead = statValue(state.defs, cards, necroIid, 'health') - cards[necroIid].damage <= 0;
    const next = { ...state, cards };
    const logged = pushLog(
      next,
      `${me.name} の ${atkName} が ${op.name} のネクロマンサーを攻撃（${atkPower}ダメージ）`
    );
    // ネクロマンサーを倒した場合は勝敗が決するので、撃破時の効果は解決しない
    if (dead) return pushLog({ ...logged, winner: pid }, `${op.name} のネクロマンサーが倒れた。${me.name} の勝利`);
    return logged;
  }

  // --- ユニット同士の戦闘（相打ちあり） ---
  const defenderIid = op.board[action.target.slot];
  const defName = defOf(state, defenderIid).name;
  const defPower = attackOf(state, defenderIid);

  cards[defenderIid] = { ...cards[defenderIid], damage: cards[defenderIid].damage + atkPower };
  cards[attackerIid] = { ...cards[attackerIid], damage: cards[attackerIid].damage + defPower };

  const defenderDead = statValue(state.defs, cards, defenderIid, 'health') - cards[defenderIid].damage <= 0;
  const attackerDead = statValue(state.defs, cards, attackerIid, 'health') - cards[attackerIid].damage <= 0;

  const ctx = {
    rules: state.rules,
    defs: state.defs,
    cards,
    turn: state.turn,   // 墓地に入った手番を刻むため（graveyardSummonBuffer の判定に使う）
    names: { [pid]: me.name, [foe]: op.name },
    boards: { [pid]: me.board.slice(), [foe]: op.board.slice() },
    graveyards: { [pid]: me.graveyard, [foe]: op.graveyard },
    decks: { [pid]: me.deck, [foe]: op.deck },
    log: [],
  };

  // 死亡処理。相打ちの順番は「守り手 → 攻め手」に固定する（決定性のため）。
  // 倒れたカードは、c05 の退避に成功しないかぎり倒した側の墓地へ行く。
  const defenderFate = defenderDead ? resolveDeath(ctx, defenderIid, foe, action.target.slot) : null;
  const attackerFate = attackerDead ? resolveDeath(ctx, attackerIid, pid, action.attackerSlot) : null;

  // 撃破時の効果（c07）。倒れた先が墓地か後列かに関わらず「倒した」事実で発動する。
  // 反撃で倒した場合も発動するかは rules.abilities.killTriggerOnCounterattack で切り替える。
  if (defenderDead) resolveKillTrigger(ctx, attackerIid, pid);
  if (attackerDead && state.rules.abilities?.killTriggerOnCounterattack !== false) {
    resolveKillTrigger(ctx, defenderIid, foe);
  }

  const next = withPlayers(
    state,
    {
      [pid]: { board: ctx.boards[pid], graveyard: ctx.graveyards[pid], deck: ctx.decks[pid] },
      [foe]: { board: ctx.boards[foe], graveyard: ctx.graveyards[foe], deck: ctx.decks[foe] },
    },
    { cards: ctx.cards }
  );

  let line = `${me.name} の ${atkName} が ${defName} を攻撃`;
  if (defenderDead && attackerDead) line += `（相打ち）`;
  else if (defenderFate === 'graveyard') line += `（${defName} を撃破 → ${me.name} の墓地へ）`;
  else if (defenderDead) line += `（${defName} を撃破）`;
  else if (attackerFate === 'graveyard') line += `（${atkName} が返り討ち → ${op.name} の墓地へ）`;
  else if (attackerDead) line += `（${atkName} が返り討ち）`;

  let out = pushLog(next, line);
  for (const l of ctx.log) out = pushLog(out, l);
  return out;
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
  const movedToGrave = {};
  if (cost > 0) {
    const points = pitch.reduce((s, iid) => s + (defOf(state, iid)?.cost || 0), 0);
    for (const iid of pitch) if (!me.hand.includes(iid)) throw new Error('ピッチ対象が手札にない');
    if (points < cost) throw new Error('配置換えの支払いが足りない');
    const set = new Set(pitch);
    hand = me.hand.filter((iid) => !set.has(iid));
    opGrave = [...opGrave, ...pitch];
    // 墓地へ入る経路なので、召喚時のピッチと同じ処理を通す
    // （controller の付け替え・呪いの再武装・墓地に入った手番の記録）。
    for (const iid of pitch) {
      movedToGrave[iid] = toGraveyardInstance(state.defs, state.cards[iid], opponentOf(pid), state.turn);
    }
  }

  const board = me.board.slice();
  const moved = board[action.fromSlot];
  board[action.fromSlot] = board[action.toSlot]; // 空きなら null、ユニットなら入れ替え
  board[action.toSlot] = moved;

  const patch = {
    [pid]: { board, hand, repositionsUsed: me.repositionsUsed + 1 },
  };
  if (cost > 0) patch[opponentOf(pid)] = { graveyard: opGrave };

  const extra = Object.keys(movedToGrave).length
    ? { cards: { ...state.cards, ...movedToGrave } }
    : {};
  const next = withPlayers(state, patch, extra);
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
    {
      // 持ち越した pt はターン終了時に消える（CG-015。無効時は常に 0 なので無害）
      [state.active]: { pitchCredit: 0 },
      [nextPid]: { drawUsed: false, repositionsUsed: 0 },
    },
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

function filterStateFor(state, playerId) {
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
      // 持ち越し pt は公開情報（ピッチも召喚も公開の行動から導ける）なので両者とも見せる
      pitchCredit: p.pitchCredit || 0,
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
// 公開（ブラウザ＝グローバル / Node＝module.exports）
// ===========================================================================

const engine = {
  createRng,
  nextRandom,
  shuffle,
  PLAYERS,
  opponentOf,
  slotIndex,
  slotRowCol,
  boardSize,
  defOf,
  attackOf,
  healthOf,
  healthLeft,
  abilityOf,
  summonSourceOwner,
  graveyardCostTotal,
  graveyardSummonTax,
  graveyardReady,
  isAttackable,
  isNecromancerAttackable,
  legalAttackTargets,
  canSummon,
  canReposition,
  legalActions,
  createInitialState,
  reduce,
  filterStateFor,
};

root.NECRO_ENGINE = engine;
if (typeof module !== 'undefined' && module.exports) module.exports = engine;

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
  const { readFileSync } = require('node:fs');
  const path = require('node:path');

  const here = __dirname;
  const cardData = require(path.join(here, '..', 'data', 'cards.js'));

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

  /** その state で、各プレイヤーの墓地に自分のカードが混ざっていないか */
  function state0OwnerCheck(s) {
    for (const pid of PLAYERS) {
      for (const iid of s.players[pid].graveyard) {
        if (s.cards[iid].owner === pid) return false;
      }
    }
    return true;
  }

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
  // ★ 枚数は data/cards.js から導く。ここに数値を書くと drawPerTurn を変えた瞬間に落ちる（CG-010）
  const afterDraw = cardData.rules.openingHand.first + cardData.rules.drawPerTurn;
  check('reduce は新しい state を返す', s1 !== s0 && s1.players.p1.hand.length === afterDraw);

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
  for (const rel of ['engine.js', 'view.js', 'ai.js']) {
    const code = stripComments(readFileSync(path.join(here, rel), 'utf8'));
    check(`${rel}: ${'Math'}.random を使っていない`, !banned.test(code));
  }

  // --- 4b. file:// で開けること（ソース検査・CG-008） ---
  // 作者は index.html をダブルクリックで開く。ES モジュールと fetch は file:// で
  // 使えないので、js/ に混入したら盤面が出なくなる。混入を検知するための番人。
  {
    const esm = /^\s*(import|export)\s/m;
    const fetchCall = new RegExp(['fetch', '\\s*\\('].join(''));
    for (const rel of ['engine.js', 'view.js', 'ai.js']) {
      const code = stripComments(readFileSync(path.join(here, rel), 'utf8'));
      check(`${rel}: ES モジュール構文を使っていない（file:// で読めなくなる）`, !esm.test(code));
      check(`${rel}: ${'fetch'} を使っていない（file:// で読めなくなる）`, !fetchCall.test(code));
    }
    // HTML コメント（この規約を説明している注意書き）は剥がしてから検査する
    const html = readFileSync(path.join(here, '..', 'index.html'), 'utf8')
      .replace(/<!--[\s\S]*?-->/g, '');
    check('index.html: script に type="module" を付けていない', !/type\s*=\s*"module"/.test(html));
    for (const rel of ['data/cards.js', 'data/ai.js', 'js/engine.js', 'js/ai.js', 'js/view.js']) {
      check(`index.html: ${rel} を読み込んでいる`, html.includes(`src="${rel}"`));
    }
  }

  // --- 5. 一貫法則: 自分のカードは自分の墓地に存在しない ---
  const end = runA.state;
  let lawHolds = true;
  for (const pid of PLAYERS) {
    for (const iid of end.players[pid].graveyard) {
      if (end.cards[iid].owner === pid) lawHolds = false;
    }
  }
  check('自分の墓地に自分のカードが存在しない（一貫法則）', lawHolds);

  // --- 6. カードの総数が保存される（能力で生成されたトークンは母数に入れない） ---
  let total = 0;
  for (const pid of PLAYERS) {
    const p = end.players[pid];
    const all = [...p.deck, ...p.hand, ...p.graveyard, ...p.board.filter(Boolean)];
    for (const iid of all) if (!end.cards[iid].token) total++;
  }
  check('カード総数が保存されている（トークンを除く）', total === cardData.deck.size * 2);

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

  // --- 8b. 先攻1ターン目の攻撃制限（CG-017・rules.firstPlayerAttacksOnTurn1） ---
  {
    const mk = (data) => {
      // p1（先攻・turn 1）の前列にユニットを1体置いた state を組み立てる
      let st = createInitialState(7, data);
      const atkIid = st.players.p1.hand[0];
      const b = st.players.p1.board.slice();
      b[slotIndex(0, 0, data.rules)] = atkIid;
      return {
        ...st,
        players: {
          ...st.players,
          p1: { ...st.players.p1, board: b, hand: st.players.p1.hand.slice(1) },
        },
      };
    };
    const atkSlot = slotIndex(0, 0, cardData.rules);

    check('既定（フラグ true）では先攻1ターン目でも攻撃できる',
      legalAttackTargets(mk(cardData), 'p1', atkSlot).length > 0);

    const dataOff = { ...cardData, rules: { ...cardData.rules, firstPlayerAttacksOnTurn1: false } };
    const sOff = mk(dataOff);
    check('制限中: 先攻1ターン目はネクロマンサーを攻撃できない',
      legalAttackTargets(sOff, 'p1', atkSlot).length === 0);

    // 相手の盤面にもユニットを置き、ユニットへの攻撃も不可であることを明示的に確かめる
    const defIid = sOff.players.p2.hand[0];
    const b2 = sOff.players.p2.board.slice();
    b2[slotIndex(0, 0, dataOff.rules)] = defIid;
    const sOff2 = {
      ...sOff,
      players: {
        ...sOff.players,
        p2: { ...sOff.players.p2, board: b2, hand: sOff.players.p2.hand.slice(1) },
      },
    };
    check('制限中: 先攻1ターン目はユニットへの攻撃もできない',
      legalAttackTargets(sOff2, 'p1', atkSlot).length === 0);
    check('制限中: legalActions に attack が現れない',
      legalActions(sOff2, 'p1').every((a) => a.type !== 'attack'));
    check('制限中: doAttack は拒否する', (() => {
      try {
        reduce(sOff2, { type: 'attack', attackerSlot: atkSlot, target: { kind: 'necromancer' } });
        return false;
      } catch {
        return true;
      }
    })());

    // 召喚・配置換えは制限されない
    // 最高コストをピッチし、最安を出す（コストは必ず足りる）
    const byCost = sOff.players.p1.hand.slice().sort(
      (a, b) => defOf(sOff, a).cost - defOf(sOff, b).cost
    );
    check('制限中: 召喚は可能',
      canSummon(sOff, 'p1', [byCost[byCost.length - 1]], [{ iid: byCost[0], from: 'hand', slot: 1 }]).ok);
    check('制限中: 配置換えは可能',
      canReposition(sOff, 'p1', atkSlot, slotIndex(1, 0, dataOff.rules)).ok);

    // 制限は「先攻の最初の手番」だけ。先攻の2手目（turn 3）は攻撃できる
    check('制限中: 先攻の2手目（turn 3）からは攻撃できる',
      legalAttackTargets({ ...sOff, turn: 3 }, 'p1', atkSlot).length > 0);
    // 後攻の最初の手番（turn 2）は制限されない
    {
      const b3 = sOff.players.p2.board.slice();
      b3[slotIndex(0, 0, dataOff.rules)] = sOff.players.p2.hand[0];
      const sTurn2 = {
        ...sOff,
        turn: 2,
        active: 'p2',
        players: {
          ...sOff.players,
          p2: { ...sOff.players.p2, board: b3, hand: sOff.players.p2.hand.slice(1) },
        },
      };
      check('制限中: 後攻の最初の手番（turn 2）は攻撃できる',
        legalAttackTargets(sTurn2, 'p2', slotIndex(0, 0, dataOff.rules)).length > 0);
    }
  }

  // --- 9. ピッチしたカードを同一 action で召喚し直せない ---
  let s3 = createInitialState(31, cardData);
  const h = s3.players.p1.hand;
  const bad = canSummon(s3, 'p1', [h[0]], [{ iid: h[0], from: 'hand', slot: 0 }]);
  check('ピッチしたカードは同じ action で召喚できない', !bad.ok);

  // --- 10. 召喚元は自分の墓地（2026-08-11 訂正） ---
  check('既定の召喚元は自分の墓地', cardData.rules.summonSource === 'ownGraveyard');
  {
    // 自分の墓地に相手のカードを1枚置き、そこからは召喚できて
    // 相手の墓地からは召喚できないことを確かめる
    let s = createInitialState(77, cardData);
    const stolen = s.players.p2.hand[0];             // p2 が持ち主のカード
    const mine = s.players.p1.hand[0];               // p1 が持ち主のカード
    s = {
      ...s,
      players: {
        ...s.players,
        p1: { ...s.players.p1, graveyard: [stolen] },
        p2: { ...s.players.p2, graveyard: [mine], hand: s.players.p2.hand.slice(1) },
      },
    };
    const pitch = [s.players.p1.hand[1], s.players.p1.hand[2], s.players.p1.hand[3]];
    const okOwn = canSummon(s, 'p1', pitch, [{ iid: stolen, from: 'graveyard', slot: 0 }]);
    const ngFoe = canSummon(s, 'p1', pitch, [{ iid: mine, from: 'graveyard', slot: 0 }]);
    check('自分の墓地からは召喚できる', okOwn.ok);
    check('相手の墓地からは召喚できない', !ngFoe.ok);
    check('自分の墓地にあるのは相手が持ち主のカードだけ', state0OwnerCheck(s));
  }

  // --- 10b. 切り替え機構（撤回前の挙動の再現用）が両方とも動くこと ---
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

  // =========================================================================
  // 11. カード能力 c05〜c08（CG-005）
  //
  // 能力の検証は乱数に頼らず、盤面を組み立ててから1手だけ進める。
  // =========================================================================

  /** デッキ（なければ手札）から指定 cardId のインスタンスを1枚抜く */
  function takeFromDeck(s, pid, cardId) {
    const p = s.players[pid];
    const iid =
      p.deck.find((i) => s.cards[i].cardId === cardId) ||
      p.hand.find((i) => s.cards[i].cardId === cardId);
    if (!iid) throw new Error(`${pid} に ${cardId} がない`);
    return {
      s: {
        ...s,
        players: {
          ...s.players,
          [pid]: {
            ...p,
            deck: p.deck.filter((i) => i !== iid),
            hand: p.hand.filter((i) => i !== iid),
          },
        },
      },
      iid,
    };
  }

  /** 盤面の枠にインスタンスを置く（テスト用の直接配置） */
  function place(s, pid, slot, iid) {
    const board = s.players[pid].board.slice();
    board[slot] = iid;
    return {
      ...s,
      players: { ...s.players, [pid]: { ...s.players[pid], board } },
      cards: { ...s.cards, [iid]: { ...s.cards[iid], controller: pid, damage: 0, attacksUsed: 0 } },
    };
  }

  /** ドロー済み・配置換え0 の状態にして、攻撃だけを試せるようにする */
  function ready(s, pid) {
    return { ...s, active: pid, players: { ...s.players, [pid]: { ...s.players[pid], drawUsed: true } } };
  }

  /** cardId から def を引く */
  const defById = (id) => cardData.cards.find((c) => c.id === id);

  // --- 11a. c05: 倒されたとき 1/1 になって後列へ移動する ---
  {
    let s = createInitialState(4001, cardData);
    let t;
    t = takeFromDeck(s, 'p1', 'c03'); s = t.s; const atkA = t.iid;   // 3/2
    t = takeFromDeck(s, 'p1', 'c03'); s = t.s; const atkB = t.iid;
    t = takeFromDeck(s, 'p2', 'c05'); s = t.s; const e = t.iid;      // 1/2 能力持ち

    s = place(s, 'p1', slotIndex(0, 0, rules), atkA);
    s = place(s, 'p1', slotIndex(0, 1, rules), atkB);
    s = place(s, 'p2', slotIndex(0, 0, rules), e);
    s = ready(s, 'p1');

    const after = reduce(s, {
      type: 'attack',
      attackerSlot: slotIndex(0, 0, rules),
      target: { kind: 'unit', slot: slotIndex(0, 0, rules) },
    });
    const backSlot = slotIndex(1, 0, rules);
    check('c05: 倒されると後列へ退く', after.players.p2.board[backSlot] === e);
    check('c05: 退いた枠は空く', after.players.p2.board[slotIndex(0, 0, rules)] === null);
    check('c05: 退いたら 1/1 になる', attackOf(after, e) === 1 && healthOf(after, e) === 1);
    check('c05: 退いた分は相手の墓地に入らない', !after.players.p1.graveyard.includes(e));

    // 移動後に再度倒されたら、通常どおり相手の墓地へ
    const after2 = reduce(after, {
      type: 'attack',
      attackerSlot: slotIndex(0, 1, rules),
      target: { kind: 'unit', slot: backSlot },
    });
    check('c05: 退いたあと再度倒されたら相手の墓地へ', after2.players.p1.graveyard.includes(e));
    check('c05: 2度目は場に残らない', after2.players.p2.board[backSlot] === null);
    check('c05: 墓地では刷られた数値に戻る', healthOf(after2, e) === defById('c05').health);
  }

  // --- 11b. c05: 後列に空きがないときは不発（通常どおり相手の墓地へ） ---
  {
    let s = createInitialState(4002, cardData);
    let t;
    t = takeFromDeck(s, 'p1', 'c03'); s = t.s; const atk = t.iid;
    t = takeFromDeck(s, 'p2', 'c05'); s = t.s; const e = t.iid;
    s = place(s, 'p1', slotIndex(0, 0, rules), atk);
    s = place(s, 'p2', slotIndex(0, 0, rules), e);
    for (let col = 0; col < rules.board.cols; col++) {
      t = takeFromDeck(s, 'p2', 'c02'); s = t.s;
      s = place(s, 'p2', slotIndex(1, col, rules), t.iid);
    }
    s = ready(s, 'p1');
    const after = reduce(s, {
      type: 'attack',
      attackerSlot: slotIndex(0, 0, rules),
      target: { kind: 'unit', slot: slotIndex(0, 0, rules) },
    });
    check('c05: 後列が埋まっていれば不発 → 相手の墓地へ', after.players.p1.graveyard.includes(e));
  }

  // --- 11c. c06: 場に出たとき、右の空き枠に 1/1 のトークンを出す ---
  {
    const mkSummonState = (slot, blockRight) => {
      let s = createInitialState(4003, cardData);
      let t;
      t = takeFromDeck(s, 'p1', 'c06'); s = t.s; const f = t.iid;
      const hand = [f];
      for (let i = 0; i < 2; i++) {
        t = takeFromDeck(s, 'p1', 'c02'); s = t.s; hand.push(t.iid);   // ピッチ用 2pt ×2
      }
      s = { ...s, players: { ...s.players, p1: { ...s.players.p1, hand } } };
      if (blockRight !== null && blockRight !== undefined) {
        t = takeFromDeck(s, 'p1', 'c01'); s = t.s;
        s = place(s, 'p1', blockRight, t.iid);
      }
      s = ready(s, 'p1');
      return { s, f, pitch: hand.slice(1) };
    };

    // 右が空 → トークンが出る
    {
      const { s, f, pitch } = mkSummonState(slotIndex(0, 0, rules), null);
      const after = reduce(s, { type: 'summon', pitch, plays: [{ iid: f, from: 'hand', slot: slotIndex(0, 0, rules) }] });
      const tok = after.players.p1.board[slotIndex(0, 1, rules)];
      check('c06: 右の空き枠にトークンが出る', !!tok && after.cards[tok].token === true);
      check('c06: トークンは 1/1', !!tok && attackOf(after, tok) === 1 && healthOf(after, tok) === 1);
      check('c06: トークンのコストは 0', !!tok && after.defs[after.cards[tok].cardId].cost === 0);
      check('c06: トークンの持ち主は出した側', !!tok && after.cards[tok].owner === 'p1');
    }
    // 右端に出た → 何も起きない
    {
      const rightEnd = slotIndex(0, rules.board.cols - 1, rules);
      const { s, f, pitch } = mkSummonState(rightEnd, null);
      const after = reduce(s, { type: 'summon', pitch, plays: [{ iid: f, from: 'hand', slot: rightEnd }] });
      check('c06: 右端なら何も起きない', after.players.p1.board.filter(Boolean).length === 1);
    }
    // 右が埋まっている → 何も起きない
    {
      const { s, f, pitch } = mkSummonState(slotIndex(0, 0, rules), slotIndex(0, 1, rules));
      const after = reduce(s, { type: 'summon', pitch, plays: [{ iid: f, from: 'hand', slot: slotIndex(0, 0, rules) }] });
      check('c06: 右が埋まっていれば何も起きない', after.players.p1.board.filter(Boolean).length === 2);
    }
  }

  // --- 11c-2. トークンは倒れると消滅する（CG-007。defs の onDeath フラグで切り替える） ---
  {
    /** c06 を召喚して (0,1) にトークンが出た局面を作る。cardData を差し替えられる */
    const withToken = (data) => {
      let s = createInitialState(4006, data);
      let t;
      t = takeFromDeck(s, 'p1', 'c06'); s = t.s; const f = t.iid;
      const hand = [f];
      for (let i = 0; i < 2; i++) {
        t = takeFromDeck(s, 'p1', 'c02'); s = t.s; hand.push(t.iid);   // ピッチ用
      }
      s = { ...s, players: { ...s.players, p1: { ...s.players.p1, hand } } };
      s = ready(s, 'p1');
      const after = reduce(s, {
        type: 'summon',
        pitch: hand.slice(1),
        plays: [{ iid: f, from: 'hand', slot: slotIndex(0, 0, rules) }],
      });
      return { s: after, tok: after.players.p1.board[slotIndex(0, 1, rules)] };
    };

    /** p2 の 3/2 でトークンを殴る */
    const killToken = (data) => {
      let { s, tok } = withToken(data);
      const t = takeFromDeck(s, 'p2', 'c03'); s = t.s;
      s = place(s, 'p2', slotIndex(0, 0, rules), t.iid);
      s = ready(s, 'p2');
      const graveBefore = s.players.p2.graveyard.length;
      const after = reduce(s, {
        type: 'attack',
        attackerSlot: slotIndex(0, 0, rules),
        target: { kind: 'unit', slot: slotIndex(0, 1, rules) },
      });
      return { after, tok, graveBefore };
    };

    // 既定（onDeath: 'vanish'）
    {
      const { after, tok, graveBefore } = killToken(cardData);
      check('トークン: 倒されると場から消える', after.players.p1.board[slotIndex(0, 1, rules)] === null);
      check('トークン: 倒した側の墓地に入らない', !after.players.p2.graveyard.includes(tok));
      check('トークン: 墓地の枚数が増えない', after.players.p2.graveyard.length === graveBefore);
      check('トークン: 実体も state に残らない', after.cards[tok] === undefined);
    }

    // フラグを 'toGraveyard' に戻すと CG-006 までの挙動になる
    {
      const t01 = cardData.tokens.list[0];
      const legacy = {
        ...cardData,
        tokens: { ...cardData.tokens, list: [{ ...t01, onDeath: 'toGraveyard' }] },
      };
      const { after, tok, graveBefore } = killToken(legacy);
      check("トークン: onDeath='toGraveyard' なら相手の墓地へ", after.players.p2.graveyard.includes(tok));
      check("トークン: onDeath='toGraveyard' なら墓地が1枚増える", after.players.p2.graveyard.length === graveBefore + 1);
    }

    // 相打ちで「倒した側」が消滅しても撃破時効果の解決が壊れない
    {
      let { s, tok } = withToken(cardData);
      const t = takeFromDeck(s, 'p2', 'c01'); s = t.s;                 // 1/1
      const prey = t.iid;
      s = place(s, 'p2', slotIndex(0, 0, rules), prey);
      const after = reduce(s, {
        type: 'attack',
        attackerSlot: slotIndex(0, 1, rules),
        target: { kind: 'unit', slot: slotIndex(0, 0, rules) },
      });
      check('トークン: 相打ちでも消滅する', after.cards[tok] === undefined);
      check('トークン: 相打ちで倒した相手は自分の墓地へ', after.players.p1.graveyard.includes(prey));
    }
  }

  // --- 11d. c07: 相手のカードを倒したとき、相手のデッキ上1枚を自分の墓地へ ---
  {
    let s = createInitialState(4004, cardData);
    let t;
    t = takeFromDeck(s, 'p1', 'c07'); s = t.s; const g = t.iid;    // 4/2
    t = takeFromDeck(s, 'p2', 'c01'); s = t.s; const prey = t.iid; // 1/1
    s = place(s, 'p1', slotIndex(0, 0, rules), g);
    s = place(s, 'p2', slotIndex(0, 0, rules), prey);
    s = ready(s, 'p1');

    const top = s.players.p2.deck[0];
    const deckBefore = s.players.p2.deck.length;
    const after = reduce(s, {
      type: 'attack',
      attackerSlot: slotIndex(0, 0, rules),
      target: { kind: 'unit', slot: slotIndex(0, 0, rules) },
    });
    check('c07: 相手のデッキ上1枚が自分の墓地へ', after.players.p1.graveyard.includes(top));
    check('c07: 相手のデッキが1枚減る', after.players.p2.deck.length === deckBefore - 1);
    check('c07: 倒したカード自体も自分の墓地へ', after.players.p1.graveyard.includes(prey));
    check('c07: 送った先でも一貫法則が保たれる', after.cards[top].owner === 'p2');

    // デッキが空なら何も起きない
    let s2 = createInitialState(4005, cardData);
    t = takeFromDeck(s2, 'p1', 'c07'); s2 = t.s; const g2 = t.iid;
    t = takeFromDeck(s2, 'p2', 'c01'); s2 = t.s; const prey2 = t.iid;
    s2 = place(s2, 'p1', slotIndex(0, 0, rules), g2);
    s2 = place(s2, 'p2', slotIndex(0, 0, rules), prey2);
    s2 = { ...s2, players: { ...s2.players, p2: { ...s2.players.p2, deck: [] } } };
    s2 = ready(s2, 'p1');
    const after2 = reduce(s2, {
      type: 'attack',
      attackerSlot: slotIndex(0, 0, rules),
      target: { kind: 'unit', slot: slotIndex(0, 0, rules) },
    });
    check('c07: 相手のデッキが空なら何も起きない', after2.players.p1.graveyard.length === 1);

    // 反撃で倒した場合も発動する（rules.abilities.killTriggerOnCounterattack）
    let s3 = createInitialState(4006, cardData);
    t = takeFromDeck(s3, 'p1', 'c01'); s3 = t.s; const weak = t.iid;  // 1/1
    t = takeFromDeck(s3, 'p2', 'c07'); s3 = t.s; const g3 = t.iid;    // 4/2
    s3 = place(s3, 'p1', slotIndex(0, 0, rules), weak);
    s3 = place(s3, 'p2', slotIndex(0, 0, rules), g3);
    s3 = ready(s3, 'p1');
    const p1Top = s3.players.p1.deck[0];
    const after3 = reduce(s3, {
      type: 'attack',
      attackerSlot: slotIndex(0, 0, rules),
      target: { kind: 'unit', slot: slotIndex(0, 0, rules) },
    });
    check('c07: 反撃で倒したときも発動する', after3.players.p2.graveyard.includes(p1Top));
  }

  // --- 11e. c08: 呪い（墓地からの召喚に最初の1回だけ +1） ---
  {
    /** p1 の墓地に「p2 が持ち主の」カードを置いた状態を作る */
    function withCurse(seed, curseCount) {
      let s = createInitialState(seed, cardData);
      let t;
      const grave = [];
      t = takeFromDeck(s, 'p2', 'c01'); s = t.s; const revive = t.iid;  // コスト1。蘇生対象
      grave.push(revive);
      const curses = [];
      for (let i = 0; i < curseCount; i++) {
        t = takeFromDeck(s, 'p2', 'c08'); s = t.s;
        curses.push(t.iid);
        grave.push(t.iid);
      }
      const cards = { ...s.cards };
      for (const iid of grave) cards[iid] = { ...cards[iid], controller: 'p1', curseArmed: true };
      // p1 の手札を作り直す（コスト1と2を1枚ずつ = ピッチ用）
      const hand = [];
      t = takeFromDeck(s, 'p1', 'c01'); s = t.s; hand.push(t.iid);      // 1pt
      t = takeFromDeck(s, 'p1', 'c02'); s = t.s; hand.push(t.iid);      // 2pt
      t = takeFromDeck(s, 'p1', 'c03'); s = t.s; hand.push(t.iid);      // 3pt
      s = {
        ...s,
        cards,
        players: {
          ...s.players,
          p1: { ...s.players.p1, hand, graveyard: grave, drawUsed: true },
        },
      };
      return { s, revive, curses, hand };
    }

    const { s, revive, curses, hand } = withCurse(4007, 1);
    check('c08: 呪い1枚で追加支払いは +1', graveyardSummonTax(s, 'p1') === 1);
    check(
      'c08: 呪いのぶんが足りないと墓地から召喚できない',
      !canSummon(s, 'p1', [hand[0]], [{ iid: revive, from: 'graveyard', slot: 0 }]).ok
    );
    check(
      'c08: 手札からの召喚には呪いが乗らない',
      canSummon(s, 'p1', [hand[2]], [{ iid: hand[1], from: 'hand', slot: 0 }]).tax === 0 &&
        canSummon(s, 'p1', [hand[2]], [{ iid: hand[1], from: 'hand', slot: 0 }]).ok
    );
    const okCheck = canSummon(s, 'p1', [hand[1]], [{ iid: revive, from: 'graveyard', slot: 0 }]);
    check('c08: 1多く払えば墓地から召喚できる', okCheck.ok && okCheck.tax === 1);

    const after = reduce(s, {
      type: 'summon',
      pitch: [hand[1]],
      plays: [{ iid: revive, from: 'graveyard', slot: 0 }],
    });
    check('c08: 発動した呪いは消費される', after.cards[curses[0]].curseArmed === false);
    check('c08: 一度発動したら再発動しない', graveyardSummonTax(after, 'p1') === 0);
    check('c08: 呪い自体は墓地に留まる', after.players.p1.graveyard.includes(curses[0]));

    // 墓地から出て、再び墓地へ入ったら数え直す
    const reArmed = {
      ...after,
      cards: {
        ...after.cards,
        [curses[0]]: toGraveyardInstance(after.defs, after.cards[curses[0]], 'p1', after.turn),
      },
    };
    check('c08: 墓地に入り直したら再武装する', graveyardSummonTax(reArmed, 'p1') === 1);

    // 複数枚は加算（rules.abilities.curseStacking = 'add'）
    const two = withCurse(4008, 2);
    check('c08: 呪い2枚なら +2（加算）', graveyardSummonTax(two.s, 'p1') === 2);
    const need3 = canSummon(two.s, 'p1', [two.hand[1]], [{ iid: two.revive, from: 'graveyard', slot: 0 }]);
    check('c08: 2枚あると 2pt では足りない', !need3.ok);
    const ok3 = canSummon(two.s, 'p1', [two.hand[2]], [{ iid: two.revive, from: 'graveyard', slot: 0 }]);
    check('c08: 3pt 払えば出せる', ok3.ok && ok3.tax === 2);
    const afterTwo = reduce(two.s, {
      type: 'summon',
      pitch: [two.hand[2]],
      plays: [{ iid: two.revive, from: 'graveyard', slot: 0 }],
    });
    check(
      'c08: 加算した呪いは同時に全部消費される',
      two.curses.every((iid) => afterTwo.cards[iid].curseArmed === false)
    );

    // 'first' に切り替えると1枚分しか乗らない
    const dataFirst = {
      ...cardData,
      rules: { ...cardData.rules, abilities: { ...cardData.rules.abilities, curseStacking: 'first' } },
    };
    const twoFirst = { ...two.s, rules: dataFirst.rules };
    check("c08: curseStacking='first' なら何枚でも +1", graveyardSummonTax(twoFirst, 'p1') === 1);
  }

  // --- 12. 決着 ---
  // ★ 見るのは runC（シード1000）。runA（シード999）ではない（CG-010）。
  //   drawPerTurn を 3 にしたところ、シード999 では上の簡易AIが手札もデッキも墓地の
  //   支払い原資も使い切り、endTurn しか合法手が無い状態で無限に続くようになった。
  //   これは SESSION_STATE の未確定項目「両者が資源を使い切ると試合が終わらない」そのもので、
  //   engine のルールの不具合ではない（簡易AIは1枚ピッチしかしないため特に枯れやすい）。
  //   決着そのものが壊れていないことは、決着する側のシードで見る。
  check('決着まで到達した（勝者あり）', runC.state.winner !== null);

  // --- 墓地召喚のバッファ（CG-011・rules.graveyardSummonBuffer） ---
  {
    // 先攻が1ターン目にピッチ → そのカードは後攻の墓地に入る。
    // 後攻が2ターン目にそれを召喚できてしまうのが CG-011 で塞いだ穴。
    const mkPitched = (data) => {
      let s = createInitialState(4242, data);
      s = reduce(s, { type: 'draw' });
      const hand = s.players.p1.hand;
      // 手札から2枚ピッチし、1枚も出さない…はできないので、出せる組を作る
      const cheap = hand.slice().sort((a, b) => defOf(s, a).cost - defOf(s, b).cost);
      const pitch = [cheap[cheap.length - 1]];
      const play = cheap.find((i) => i !== pitch[0] && defOf(s, i).cost <= defOf(s, pitch[0]).cost);
      s = reduce(s, { type: 'summon', pitch, plays: [{ iid: play, from: 'hand', slot: 0 }] });
      s = reduce(s, { type: 'endTurn' });   // → ターン2、p2 の手番
      return { s, pitched: pitch[0] };
    };

    // buffer = 2（CG-011〜CG-015 の既定。CG-016 で既定を 0 にしたが、機能は残す）: 後攻は2ターン目に使えない
    const d2 = { ...cardData, rules: { ...cardData.rules, graveyardSummonBuffer: 2 } };
    const a = mkPitched(d2);
    check('バッファ: 既定値は0（CG-016）', cardData.rules.graveyardSummonBuffer === 0);
    check('バッファ: ピッチしたカードは相手の墓地に入る', a.s.players.p2.graveyard.includes(a.pitched));
    check('バッファ: 墓地に入った手番が記録されている', a.s.cards[a.pitched].enteredGraveyardTurn === 1);
    check('バッファ: 後攻はターン2で召喚できない', !graveyardReady(a.s, a.pitched));
    {
      const hand = a.s.players.p2.hand;
      const big = hand.slice().sort((x, y) => defOf(a.s, y).cost - defOf(a.s, x).cost)[0];
      const r = canSummon(a.s, 'p2', [big], [{ iid: a.pitched, from: 'graveyard', slot: 0 }]);
      check('バッファ: canSummon が理由つきで拒否する', !r.ok && /墓地に入ったばかり/.test(r.reason));
    }
    // 解除は turn - entered >= 2。entered=1 なのでターン3で条件を満たすが、
    // ターン3は先攻(p1)の手番なので、★ 墓地の持ち主(p2)が実際に使えるのはターン4。
    let later = reduce(a.s, { type: 'endTurn' });          // ターン3（p1 の手番）
    check('バッファ: ターン3で解除条件を満たす', graveyardReady(later, a.pitched));
    check('バッファ: ただしターン3は先攻の手番', later.active === 'p1' && later.turn === 3);
    later = reduce(later, { type: 'endTurn' });            // ターン4（p2 の手番）
    check('バッファ: 後攻が実際に使えるのはターン4', later.active === 'p2' && graveyardReady(later, a.pitched));

    // buffer = 0（既定・CG-016）: その場で召喚できる
    const d0 = { ...cardData, rules: { ...cardData.rules, graveyardSummonBuffer: 0 } };
    const b = mkPitched(d0);
    check('バッファ: 0 なら即座に召喚できる（既定の挙動）', graveyardReady(b.s, b.pitched));

    // buffer = 1 は「同じ手番で出し直す」だけを止める
    const d1 = { ...cardData, rules: { ...cardData.rules, graveyardSummonBuffer: 1 } };
    const c = mkPitched(d1);
    check('バッファ: 1 なら次の手番から使える', graveyardReady(c.s, c.pitched));

    // 決定性: 同じシードで同じ結果
    const p1 = playout(2611, 400, cardData);
    const p2 = playout(2611, 400, cardData);
    check('バッファ: 同一シードで同一結果', JSON.stringify(p1.state) === JSON.stringify(p2.state));
  }

  // --- ピッチ pt のターン内持ち越し（CG-015・rules.pitchCarryover） ---
  {
    check('持ち越し: 既定は無効（従来の挙動）', cardData.rules.pitchCarryover === false);

    /** p1 の手札を [c04(5pt), c01, c01] にした手番中の状態を作る */
    const mk = (data) => {
      let s = createInitialState(4501, data);
      let t;
      t = takeFromDeck(s, 'p1', 'c04'); s = t.s; const big = t.iid;
      t = takeFromDeck(s, 'p1', 'c01'); s = t.s; const a1 = t.iid;
      t = takeFromDeck(s, 'p1', 'c01'); s = t.s; const a2 = t.iid;
      s = { ...s, players: { ...s.players, p1: { ...s.players.p1, hand: [big, a1, a2] } } };
      s = ready(s, 'p1');
      return { s, big, a1, a2 };
    };

    // 無効（既定）: 余った pt は召喚の確定とともに消える
    {
      const { s, big, a1, a2 } = mk(cardData);
      const after = reduce(s, { type: 'summon', pitch: [big], plays: [{ iid: a1, from: 'hand', slot: 0 }] });
      check('持ち越し無効: 余り 4pt は記録されない', (after.players.p1.pitchCredit || 0) === 0);
      check(
        '持ち越し無効: 余りを次の召喚に使えない',
        !canSummon(after, 'p1', [], [{ iid: a2, from: 'hand', slot: 1 }]).ok
      );
    }

    // 有効: 余りが同一手番内に持ち越され、ターン終了で消える
    {
      const dOn = { ...cardData, rules: { ...cardData.rules, pitchCarryover: true } };
      const { s, big, a1, a2 } = mk(dOn);
      const first = canSummon(s, 'p1', [big], [{ iid: a1, from: 'hand', slot: 0 }]);
      check('持ち越し有効: canSummon が credit を返す', first.ok && first.credit === 0);
      const after = reduce(s, { type: 'summon', pitch: [big], plays: [{ iid: a1, from: 'hand', slot: 0 }] });
      check('持ち越し有効: 余り 4pt が持ち越される', after.players.p1.pitchCredit === 4);
      const second = canSummon(after, 'p1', [], [{ iid: a2, from: 'hand', slot: 1 }]);
      check('持ち越し有効: ピッチ0枚でも持ち越しで払える', second.ok && second.credit === 4);
      const after2 = reduce(after, { type: 'summon', pitch: [], plays: [{ iid: a2, from: 'hand', slot: 1 }] });
      check('持ち越し有効: 使った分だけ減る', after2.players.p1.pitchCredit === 3);
      const v = filterStateFor(after2, 'p2');
      check('持ち越し有効: 視点フィルタでも残 pt が見える（公開情報）', v.players.p1.pitchCredit === 3);
      const ended = reduce(after2, { type: 'endTurn' });
      check('持ち越し有効: ターン終了で消える', ended.players.p1.pitchCredit === 0);

      const r1 = playout(2733, 400, dOn);
      const r2 = playout(2733, 400, dOn);
      check('持ち越し有効: 同一シードで同一結果', JSON.stringify(r1.state) === JSON.stringify(r2.state));
    }

    // 呪い（c08）との相互作用: 乗る額・条件は変わらず、持ち越した pt でも払える
    {
      const dOn = { ...cardData, rules: { ...cardData.rules, pitchCarryover: true } };
      let s = createInitialState(4502, dOn);
      let t;
      t = takeFromDeck(s, 'p2', 'c01'); s = t.s; const revive = t.iid;   // コスト1。蘇生対象
      t = takeFromDeck(s, 'p2', 'c08'); s = t.s; const curse = t.iid;    // 呪い
      const cards = { ...s.cards };
      for (const iid of [revive, curse]) cards[iid] = { ...cards[iid], controller: 'p1', curseArmed: true };
      s = {
        ...s,
        cards,
        active: 'p1',
        players: {
          ...s.players,
          p1: { ...s.players.p1, hand: [], graveyard: [revive, curse], pitchCredit: 2, drawUsed: true },
        },
      };
      const r = canSummon(s, 'p1', [], [{ iid: revive, from: 'graveyard', slot: 0 }]);
      check('持ち越し×呪い: 持ち越し pt だけでコスト+呪いを払える', r.ok && r.tax === 1 && r.credit === 2);
      const after = reduce(s, { type: 'summon', pitch: [], plays: [{ iid: revive, from: 'graveyard', slot: 0 }] });
      check('持ち越し×呪い: 支払い後の残りは 0（1pt+呪い1pt を消費）', after.players.p1.pitchCredit === 0);
      check('持ち越し×呪い: 呪いは発動して消費される', after.cards[curse].curseArmed === false);
      // 持ち越しが足りなければ、従来どおり拒否される
      const s1 = { ...s, players: { ...s.players, p1: { ...s.players.p1, pitchCredit: 1 } } };
      check(
        '持ち越し×呪い: 1pt では足りない（呪い分が乗る）',
        !canSummon(s1, 'p1', [], [{ iid: revive, from: 'graveyard', slot: 0 }]).ok
      );
    }
  }

  console.log(
    failures === 0
      ? `\n${checks} 件すべて成功`
      : `\n${checks} 件中 ${failures} 件失敗`
  );
  if (failures > 0) process.exit(1);
}

})(typeof globalThis !== 'undefined' ? globalThis : this);

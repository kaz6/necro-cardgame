/**
 * engine.js — 純粋なゲームロジック（v0.3 モック1・CG-021）
 *
 * 【不可逆制約】詳細は CLAUDE.md
 *   - DOM / window / document に一切触らない。Node 単体で実行できること
 *   - (state, action) => newState の純粋関数。既存 state を破壊的に変更しない
 *   - action は JSON 化可能なオブジェクトのみ
 *   - filterStateFor(state, playerId) で相手の手札と両者の山の中身を落とす
 *   - 乱数は下記 seeded RNG のみ。Math.random() 禁止
 *   - 駒の数値・動き・ルールフラグは data/cards.js。ここにベタ書きしない
 *
 * 【仕様の正本】Notion CURRENT_SPEC「v0.3 モック1 仕様」
 *   7×7・キングだけの空の盤から育てる・1手番1行動・強さ1値の戦闘・寝返り・
 *   N 回目に倒されたら元の持ち主の山へ・取られた側ドラフト。
 *
 * 【読み込み形式】CG-008 を踏襲
 *   全体を即時関数で包み、ブラウザ＝グローバル NECRO_ENGINE、Node＝module.exports。
 *   この外側の包みを外さないこと。
 *
 * 【action】
 *   { type: 'move',  from: 'D7', to: 'D6' }          盤上の自分の駒を動かす（攻撃を含む）
 *   { type: 'place', pieceId: 'p1-03', to: 'C7' }    手札から1枚置く
 *   { type: 'draw' }                                 引く（rules.drawMode = 'action' のときだけ）
 *   { type: 'pass' }                                 合法手が1つもないときだけ
 *   { type: 'placeDefector', to: 'E6' }              寝返った駒を置く（手番を使わない）
 *   { type: 'draftPick', keep: 0 }                   ドラフト：options[keep] を自分の手札、残りを相手へ
 *   上の4つが「手」（ply を1進める）。下の2つは保留中の決定で、手を進めない。
 */

(function (root) {
'use strict';

// ===========================================================================
// seeded RNG — 状態は state の一部として持ち回る（v0.2 と同じ mulberry32）
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
// 座標
// ===========================================================================

const PLAYERS = ['p1', 'p2'];

function opponentOf(playerId) {
  return playerId === 'p1' ? 'p2' : 'p1';
}

/** 'D7' → { x: 3, y: 7 }（x は 0 始まりの列、y は 1 始まりの行） */
function parseSquare(state, sq) {
  if (typeof sq !== 'string' || sq.length < 2) return null;
  const x = state.board.colNames.indexOf(sq[0]);
  const y = Number(sq.slice(1));
  if (x < 0 || !Number.isInteger(y) || y < 1 || y > state.board.rows) return null;
  return { x, y };
}

function squareName(state, x, y) {
  return state.board.colNames[x] + String(y);
}

function inBoard(state, x, y) {
  return x >= 0 && x < state.board.cols && y >= 1 && y <= state.board.rows;
}

function squareIndex(state, sq) {
  const p = parseSquare(state, sq);
  return p ? (p.y - 1) * state.board.cols + p.x : -1;
}

function allSquares(state) {
  const out = [];
  for (let y = 1; y <= state.board.rows; y++) {
    for (let x = 0; x < state.board.cols; x++) out.push(squareName(state, x, y));
  }
  return out;
}

/** その持ち主から見た「前」の向き（行の増減）。p1 は行7の側なので前は行が減る向き */
function forwardOf(state, playerId) {
  return state.board.homeRow[playerId] === state.board.rows ? -1 : 1;
}

// ===========================================================================
// state の読み取りヘルパ（view・AI はルール判定をここに委ねる）
// ===========================================================================

function pieceAt(state, sq) {
  const i = squareIndex(state, sq);
  if (i < 0) return null;
  const id = state.cells[i];
  return id ? state.pieces[id] : null;
}

function defOf(state, piece) {
  return state.defs[piece.kind];
}

function moveTypeOf(state, piece) {
  return state.moveTypes[defOf(state, piece).move];
}

function kingSquare(state, playerId) {
  for (let i = 0; i < state.cells.length; i++) {
    const id = state.cells[i];
    if (id && state.pieces[id].kind === state.kingKind && state.pieces[id].controller === playerId) {
      return squareName(state, i % state.board.cols, Math.floor(i / state.board.cols) + 1);
    }
  }
  return null;
}

/** 盤上の駒の数 */
function boardCount(state) {
  let n = 0;
  for (const id of state.cells) if (id) n++;
  return n;
}

/** いま決定を下すプレイヤー（保留中の決定があればその持ち主、なければ手番の側） */
function decider(state) {
  if (state.result) return null;
  if (state.pending.length > 0) return state.pending[0].player;
  return state.active;
}

/**
 * 駒の移動先（攻撃先を含む）。
 * ★ ナイト以外は他の駒を飛び越えない。slide の駒は最初に当たった駒で止まる（敵なら攻撃先）。
 * ★ capture を持つ型（ポーン）は move の方向では取れず、capture の方向は取るときだけ。
 * ★ 「前」は今の持ち主（controller）から見た向き。寝返ると向きも反転する。
 */
function movesFrom(state, sq) {
  const piece = pieceAt(state, sq);
  if (!piece) return [];
  const from = parseSquare(state, sq);
  const mt = moveTypeOf(state, piece);
  const fwd = forwardOf(state, piece.controller);
  const out = [];
  const consider = (dx, dy, mode) => {
    // mode: 'both' | 'moveOnly' | 'captureOnly'
    let x = from.x;
    let y = from.y;
    for (;;) {
      x += dx;
      y += dy * fwd;
      if (!inBoard(state, x, y)) return;
      const target = pieceAt(state, squareName(state, x, y));
      if (!target) {
        if (mode !== 'captureOnly') out.push({ to: squareName(state, x, y), capture: false });
      } else {
        if (target.controller !== piece.controller && mode !== 'moveOnly') {
          out.push({ to: squareName(state, x, y), capture: true });
        }
        return;   // 飛び越えない（jump の駒は slide しないのでここに来ても1歩で終わる）
      }
      if (!mt.slide) return;
    }
  };
  const hasCapture = Array.isArray(mt.capture);
  for (const [dx, dy] of mt.move) consider(dx, dy, hasCapture ? 'moveOnly' : 'both');
  if (hasCapture) for (const [dx, dy] of mt.capture) consider(dx, dy, 'captureOnly');
  return out;
}

/** 手札の駒を置けるマス（自陣の奥の列から range 列ぶん・空きマスのみ） */
function placementSquares(state, playerId, pieceId) {
  const piece = state.pieces[pieceId];
  if (!piece) return [];
  const range = defOf(state, piece).range;
  const home = state.board.homeRow[playerId];
  const fwd = forwardOf(state, playerId);
  const out = [];
  for (let k = 0; k <= range; k++) {
    const y = home + fwd * k;
    if (y < 1 || y > state.board.rows) continue;
    for (let x = 0; x < state.board.cols; x++) {
      const sq = squareName(state, x, y);
      if (!pieceAt(state, sq)) out.push(sq);
    }
  }
  return out;
}

/** 戦闘の結果予想：'win'（攻撃側が上）| 'lose'（防御側が上）| 'tie' | null（攻撃ではない） */
function battleOutcome(state, from, to) {
  const a = pieceAt(state, from);
  const d = pieceAt(state, to);
  if (!a || !d || a.controller === d.controller) return null;
  if (a.strength > d.strength) return 'win';
  if (a.strength < d.strength) return 'lose';
  return 'tie';
}

/**
 * その移動で倒れるキングの持ち主（'p1' | 'p2' | 'both' | null）。
 * ★ 同値でキングが絡むときの扱い（rules.kingTie）もここで判定する。AI・view はこれに訊く。
 */
function kingFallsBy(state, from, to) {
  const a = pieceAt(state, from);
  const d = pieceAt(state, to);
  const outcome = battleOutcome(state, from, to);
  if (!outcome) return null;
  const aKing = a.kind === state.kingKind;
  const dKing = d.kind === state.kingKind;
  if (outcome === 'win') return dKing ? d.controller : null;
  if (outcome === 'lose') return aKing ? a.controller : null;
  if (state.rules.kingTie !== 'kingFalls') return null;
  if (aKing && dKing) return 'both';
  if (aKing) return a.controller;
  if (dKing) return d.controller;
  return null;
}

/** 周囲8マスの空きマス */
function emptyNeighbors(state, sq) {
  if (!sq) return [];
  const c = parseSquare(state, sq);
  const out = [];
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      if (dx === 0 && dy === 0) continue;
      const x = c.x + dx;
      const y = c.y + dy;
      if (!inBoard(state, x, y)) continue;
      const s = squareName(state, x, y);
      if (!pieceAt(state, s)) out.push(s);
    }
  }
  return out;
}

/**
 * 合法手の一覧。
 * ★ filterStateFor を通した state でも、その視点のプレイヤーについては同じ結果を返す
 *   （AI はフィルタ済みの state しか見ないため）。
 */
function legalActions(state, playerId) {
  if (state.result) return [];
  if (decider(state) !== playerId) return [];
  if (state.pending.length > 0) {
    const p = state.pending[0];
    if (p.type === 'placeDefector') return p.squares.map((to) => ({ type: 'placeDefector', to }));
    if (p.type === 'draft') return p.options.map((_, i) => ({ type: 'draftPick', keep: i }));
    return [];
  }
  const out = [];
  for (const sq of allSquares(state)) {
    const pc = pieceAt(state, sq);
    if (!pc || pc.controller !== playerId) continue;
    for (const m of movesFrom(state, sq)) out.push({ type: 'move', from: sq, to: m.to });
  }
  const hand = state.players[playerId].hand || [];
  for (const id of hand) {
    for (const to of placementSquares(state, playerId, id)) out.push({ type: 'place', pieceId: id, to });
  }
  if (state.rules.drawMode === 'action' && deckCount(state, playerId) > 0) out.push({ type: 'draw' });
  if (out.length === 0) out.push({ type: 'pass' });
  return out;
}

function deckCount(state, playerId) {
  const p = state.players[playerId];
  return Array.isArray(p.deck) ? p.deck.length : p.deckCount;
}

function handCount(state, playerId) {
  const p = state.players[playerId];
  return Array.isArray(p.hand) ? p.hand.length : p.handCount;
}

// ===========================================================================
// 初期化
// ===========================================================================

/**
 * @param {number} seed
 * @param {object} cardData data/cards.js の中身
 * @param {object} [ruleOverrides] rules の上書き（デバッグパネル・比較測定用。data は書き換えない）
 */
function createInitialState(seed, cardData, ruleOverrides) {
  const rules = { ...cardData.rules, ...(ruleOverrides || {}) };
  delete rules._note;
  const defs = {};
  for (const d of cardData.pieces.list) {
    defs[d.kind] = { kind: d.kind, move: d.move, strength: d.strength, range: d.range, short: d.short, symbol: d.symbol };
  }
  const k = cardData.king;
  defs[k.kind] = { kind: k.kind, move: k.move, strength: k.strength, range: null, short: k.short, symbol: k.symbol };
  const moveTypes = {};
  for (const key of Object.keys(cardData.moveTypes)) {
    if (key[0] === '_') continue;
    moveTypes[key] = cardData.moveTypes[key];
  }
  const board = {
    cols: cardData.board.cols,
    rows: cardData.board.rows,
    colNames: cardData.board.colNames.slice(),
    homeRow: { ...cardData.board.homeRow },
  };

  let rng = createRng(seed);
  const pieces = {};
  const players = {};
  for (const pid of PLAYERS) {
    const kinds = [];
    for (const d of cardData.pieces.list) for (let i = 0; i < d.count; i++) kinds.push(d.kind);
    const sh = shuffle(kinds, rng);
    rng = sh.rng;
    // ★ id はシャッフル後の位置で振る（id から種類が推測できないように）
    const deck = sh.items.map((kind, i) => {
      const id = `${pid}-${String(i).padStart(2, '0')}`;
      pieces[id] = { id, kind, owner: pid, controller: pid, strength: defs[kind].strength, defeats: 0 };
      return id;
    });
    const kingId = `${pid}-K`;
    pieces[kingId] = { id: kingId, kind: k.kind, owner: pid, controller: pid, strength: k.strength, defeats: 0 };
    players[pid] = { deck: deck.slice(rules.initialHand), hand: deck.slice(0, rules.initialHand) };
  }

  let state = {
    version: cardData.version,
    seed,
    rng,
    kingKind: k.kind,
    rules,
    board,
    defs,
    moveTypes,
    cells: new Array(board.cols * board.rows).fill(null),
    pieces,
    players,
    active: 'p1',
    ply: 0,
    pending: [],
    result: null,
    stats: emptyStats(),
    lastEvents: [],
  };
  const cells = state.cells.slice();
  for (const pid of PLAYERS) cells[squareIndex(state, k.start[pid])] = `${pid}-K`;
  state = { ...state, cells };
  // 先手の最初の手番の開始時にも引く（仕様の文言どおり「手番の開始時」）
  return startTurn(state, 'p1', []);
}

function emptyStats() {
  return {
    moves: 0,
    places: 0,
    draws: 0,
    passes: 0,
    battles: 0,
    ties: 0,
    defections: 0,
    returnsNth: 0,
    returnsTie: 0,
    returnsNoSpace: 0,
    drafts: 0,
  };
}

// ===========================================================================
// reduce
// ===========================================================================

function reduce(state, action) {
  if (!action || typeof action.type !== 'string') throw new Error('action が不正です');
  if (state.result) throw new Error('対戦は終わっています');
  const who = decider(state);
  const legal = legalActions(state, who);
  const key = actionKey(action);
  if (!legal.some((a) => actionKey(a) === key)) {
    throw new Error(`合法手ではありません: ${JSON.stringify(action)}（決定する側 ${who}）`);
  }
  switch (action.type) {
    case 'move': return afterMainAction(doMove(state, action));
    case 'place': return afterMainAction(doPlace(state, action));
    case 'draw': return afterMainAction(doDrawAction(state));
    case 'pass': return afterMainAction(addStat({ ...state, lastEvents: [{ type: 'pass', player: who }] }, 'passes'));
    case 'placeDefector': return advanceIfDone(doPlaceDefector(state, action));
    case 'draftPick': return advanceIfDone(doDraftPick(state, action));
    default: throw new Error(`未知の action: ${action.type}`);
  }
}

/** action の比較用キー（JSON 化可能なフィールドだけを固定順で並べる） */
function actionKey(a) {
  return [a.type, a.from || '', a.to || '', a.pieceId || '', a.keep === undefined ? '' : a.keep].join('|');
}

function addStat(state, key, n = 1) {
  return { ...state, stats: { ...state.stats, [key]: state.stats[key] + n } };
}

function setCell(state, sq, id) {
  const cells = state.cells.slice();
  cells[squareIndex(state, sq)] = id;
  return { ...state, cells };
}

function setPiece(state, id, patch) {
  return { ...state, pieces: { ...state.pieces, [id]: { ...state.pieces[id], ...patch } } };
}

function setPlayer(state, pid, patch) {
  return { ...state, players: { ...state.players, [pid]: { ...state.players[pid], ...patch } } };
}

/** 元の持ち主の山の底へ還す。強さは元の値・持ち主は元の持ち主に戻る */
function returnToDeck(state, id) {
  const pc = state.pieces[id];
  const patch = { controller: pc.owner, strength: state.defs[pc.kind].strength };
  if (state.rules.resetDefeatsOnReturn) patch.defeats = 0;
  let s = setPiece(state, id, patch);
  s = setPlayer(s, pc.owner, { deck: [...s.players[pc.owner].deck, id] });
  return s;
}

function doPlace(state, action) {
  const pid = state.active;
  let s = setCell(state, action.to, action.pieceId);
  s = setPiece(s, action.pieceId, { controller: pid });
  s = setPlayer(s, pid, { hand: s.players[pid].hand.filter((id) => id !== action.pieceId) });
  s = { ...s, lastEvents: [{ type: 'place', player: pid, pieceId: action.pieceId, to: action.to }] };
  return addStat(s, 'places');
}

function doDrawAction(state) {
  const pid = state.active;
  const s = drawOne(state, pid);
  return { ...s, lastEvents: [{ type: 'draw', player: pid }] };
}

function drawOne(state, pid) {
  const deck = state.players[pid].deck;
  if (deck.length === 0) return state;
  const s = setPlayer(state, pid, { deck: deck.slice(1), hand: [...state.players[pid].hand, deck[0]] });
  return addStat(s, 'draws');
}

/**
 * 移動・攻撃。
 * 攻撃側が上 → 防御側が倒れ、攻撃側がそのマスに入る。
 * 防御側が上 → 攻撃側が倒れ、防御側はそのまま。
 * 同値 → 両方とも元の持ち主の山の底へ（攻撃側 → 防御側の順）。ドラフトは起きない。
 */
function doMove(state, action) {
  const pid = state.active;
  const attacker = pieceAt(state, action.from);
  const defender = pieceAt(state, action.to);
  let s = state;
  const events = [];
  if (!defender) {
    s = setCell(s, action.from, null);
    s = setCell(s, action.to, attacker.id);
    s = { ...s, lastEvents: [{ type: 'move', player: pid, pieceId: attacker.id, from: action.from, to: action.to }] };
    return addStat(s, 'moves');
  }

  s = addStat(addStat(s, 'moves'), 'battles');
  const outcome = battleOutcome(s, action.from, action.to);
  events.push({
    type: 'battle', player: pid, from: action.from, to: action.to,
    attackerId: attacker.id, defenderId: defender.id,
    attackerStrength: attacker.strength, defenderStrength: defender.strength, outcome,
  });

  if (outcome === 'tie') {
    s = addStat(s, 'ties');
    const aKing = attacker.kind === s.kingKind;
    const dKing = defender.kind === s.kingKind;
    if ((aKing || dKing) && s.rules.kingTie === 'kingFalls') {
      // ★ 仕様の曖昧な点（キングは山へ還れない）。既定はキングが倒れて決着
      const winner = aKing && dKing ? null : aKing ? defender.controller : attacker.controller;
      events.push({ type: 'kingFell', tie: true, losers: [aKing ? attacker.controller : null, dKing ? defender.controller : null].filter(Boolean) });
      return { ...s, lastEvents: events, result: { winner, reason: aKing && dKing ? 'bothKings' : 'king', ply: s.ply + 1 } };
    }
    // kingSurvives: キングはその場に残り、相手の駒だけ山へ。両方キングなら何も起きない
    if (!aKing) {
      s = setCell(s, action.from, null);
      s = returnToDeck(s, attacker.id);
      s = addStat(s, 'returnsTie');
      events.push({ type: 'return', pieceId: attacker.id, owner: attacker.owner, why: 'tie' });
    }
    if (!dKing) {
      s = setCell(s, action.to, null);
      s = returnToDeck(s, defender.id);
      s = addStat(s, 'returnsTie');
      events.push({ type: 'return', pieceId: defender.id, owner: defender.owner, why: 'tie' });
    }
    return { ...s, lastEvents: events };
  }

  const win = outcome === 'win';
  const winner = win ? attacker : defender;
  const loser = win ? defender : attacker;
  const winnerSq = win ? action.to : action.to;   // 攻撃側が勝てば移動先へ入る。防御側が勝てばそのまま
  // 盤の更新
  s = setCell(s, action.from, null);
  s = setCell(s, action.to, winner.id);
  // 勝った側の強さ（フラグ）。★ 減った値は手番をまたいで残る
  if (s.rules.winnerLosesStrength) {
    s = setPiece(s, winner.id, { strength: winner.strength - loser.strength });
  }

  if (loser.kind === s.kingKind) {
    events.push({ type: 'kingFell', tie: false, losers: [loser.controller] });
    return { ...s, lastEvents: events, result: { winner: winner.controller, reason: 'king', ply: s.ply + 1 } };
  }

  // 倒された回数を数え、N 回目なら寝返らず元の持ち主の山の底へ
  const defeats = loser.defeats + 1;
  s = setPiece(s, loser.id, { defeats });
  const lostSide = loser.controller;
  const gainSide = winner.controller;
  if (defeats >= s.rules.defeatsToReturn) {
    s = returnToDeck(s, loser.id);
    s = addStat(s, 'returnsNth');
    events.push({ type: 'return', pieceId: loser.id, owner: loser.owner, why: 'nth', defeats });
  } else {
    // 寝返り：強さは元の値に戻る。置き場所は倒した側が選ぶ（保留中の決定）
    s = setPiece(s, loser.id, { controller: gainSide, strength: s.defs[loser.kind].strength });
    const anchor = s.rules.defectorPlacement === 'winner' ? winnerSq : kingSquare(s, gainSide);
    const squares = emptyNeighbors(s, anchor);
    if (squares.length === 0) {
      s = returnToDeck(s, loser.id);
      s = addStat(s, 'returnsNoSpace');
      events.push({ type: 'return', pieceId: loser.id, owner: loser.owner, why: 'noSpace' });
    } else {
      s = addStat(s, 'defections');
      events.push({ type: 'defect', pieceId: loser.id, to: gainSide });
      s = { ...s, pending: [...s.pending, { type: 'placeDefector', player: gainSide, pieceId: loser.id, squares }] };
    }
  }
  // 取られた側ドラフト（寝返り・山へ還る、のどちらでも）
  s = { ...s, lastEvents: events };
  s = queueDraft(s, lostSide);
  return s;
}

/**
 * 取られた側ドラフト：自分の山の上から2枚を見て、1枚を自分の手札、もう1枚を相手の手札へ。
 * 山が1枚ならその1枚を自分の手札へ（選ぶものがないので保留にしない）。山が空なら何もしない。
 * ★ 山から2枚を「見ている」間は山から抜いて pending に持つ（フィルタで隠す）。
 */
function queueDraft(state, pid) {
  const deck = state.players[pid].deck;
  if (deck.length === 0) {
    return { ...state, lastEvents: [...state.lastEvents, { type: 'draftSkipped', player: pid }] };
  }
  let s = addStat(state, 'drafts');
  if (deck.length === 1) {
    s = setPlayer(s, pid, { deck: [], hand: [...s.players[pid].hand, deck[0]] });
    return { ...s, lastEvents: [...s.lastEvents, { type: 'draftSingle', player: pid }] };
  }
  const n = Math.min(state.rules.draftSize, deck.length);
  const options = deck.slice(0, n);
  s = setPlayer(s, pid, { deck: deck.slice(n) });
  s = { ...s, pending: [...s.pending, { type: 'draft', player: pid, options }] };
  return { ...s, lastEvents: [...s.lastEvents, { type: 'draftOpen', player: pid }] };
}

function doPlaceDefector(state, action) {
  const p = state.pending[0];
  let s = setCell(state, action.to, p.pieceId);
  s = { ...s, pending: s.pending.slice(1) };
  return { ...s, lastEvents: [{ type: 'placeDefector', player: p.player, pieceId: p.pieceId, to: action.to }] };
}

function doDraftPick(state, action) {
  const p = state.pending[0];
  const keep = p.options[action.keep];
  const give = p.options.filter((_, i) => i !== action.keep);
  const opp = opponentOf(p.player);
  let s = setPlayer(state, p.player, { hand: [...state.players[p.player].hand, keep] });
  s = setPlayer(s, opp, { hand: [...s.players[opp].hand, ...give] });
  s = { ...s, pending: s.pending.slice(1) };
  return { ...s, lastEvents: [{ type: 'draftPick', player: p.player }] };
}

/** 手を1つ指した後：手数を進め、決着・保留がなければ手番を渡す */
function afterMainAction(state) {
  const s = { ...state, ply: state.ply + 1 };
  if (s.result) return s;
  return advanceIfDone(s);
}

function advanceIfDone(state) {
  if (state.result || state.pending.length > 0) return state;
  if (state.ply >= state.rules.maxPlies) {
    return { ...state, result: { winner: null, reason: 'maxPlies', ply: state.ply } };
  }
  const next = opponentOf(state.active);
  return startTurn({ ...state, active: next }, next, state.lastEvents);
}

function startTurn(state, pid, events) {
  if (state.rules.drawMode !== 'turnStart') return { ...state, lastEvents: events };
  if (state.players[pid].deck.length === 0) return { ...state, lastEvents: events };
  const s = drawOne(state, pid);
  return { ...s, lastEvents: [...events, { type: 'turnDraw', player: pid }] };
}

// ===========================================================================
// 視点フィルタ
// ===========================================================================

/**
 * そのプレイヤーが見てよい情報だけを残した新しい state。
 *   - 相手の手札：中身を落とし、枚数だけ残す
 *   - 両者の山：中身を落とし、枚数だけ残す（自分の山の順番も見せない）
 *   - ドラフトで見ている2枚：見ている本人以外には枚数だけ
 *   - rng：丸ごと落とす（山の順番の先読みを防ぐ）
 *   - pieces：見えない駒のレコードは落とす（id から種類を引けないように）
 * playerId に null を渡すと観戦者（両者の手札とも見えない）。
 */
function filterStateFor(state, playerId) {
  const visible = new Set();
  for (const id of state.cells) if (id) visible.add(id);
  const players = {};
  for (const pid of PLAYERS) {
    const p = state.players[pid];
    const own = pid === playerId;
    players[pid] = {
      deckCount: p.deck.length,
      handCount: p.hand.length,
      hand: own ? p.hand.slice() : null,
    };
    if (own) for (const id of p.hand) visible.add(id);
  }
  const pending = state.pending.map((p) => {
    if (p.type === 'draft') {
      if (p.player === playerId) {
        for (const id of p.options) visible.add(id);
        return { type: 'draft', player: p.player, options: p.options.slice() };
      }
      return { type: 'draft', player: p.player, options: null, optionCount: p.options.length };
    }
    visible.add(p.pieceId);   // 寝返った駒は盤から降りたばかりの公開情報
    return { ...p, squares: p.squares.slice() };
  });
  const pieces = {};
  for (const id of visible) pieces[id] = { ...state.pieces[id] };
  // イベントに出る駒のうち、いま見えない駒（山へ還った駒など）は id を落として種類だけ残す。
  // ★ 種類は盤上で全員が見ていた公開情報。id を残すと山の中身（どの駒がどこにあるか）を辿れる
  const lastEvents = state.lastEvents.map((e) => {
    const out = { ...e };
    for (const key of ['pieceId', 'attackerId', 'defenderId']) {
      if (out[key] && !visible.has(out[key])) {
        out[key.replace('Id', 'Kind')] = state.pieces[out[key]].kind;
        delete out[key];
      }
    }
    return out;
  });
  return {
    version: state.version,
    seed: state.seed,
    kingKind: state.kingKind,
    viewer: playerId,
    rules: { ...state.rules },
    board: state.board,
    defs: state.defs,
    moveTypes: state.moveTypes,
    cells: state.cells.slice(),
    pieces,
    players,
    active: state.active,
    ply: state.ply,
    pending,
    result: state.result ? { ...state.result } : null,
    stats: { ...state.stats },
    lastEvents,
  };
}

// ===========================================================================

const engine = {
  PLAYERS,
  createRng,
  nextRandom,
  shuffle,
  opponentOf,
  parseSquare,
  squareName,
  squareIndex,
  allSquares,
  forwardOf,
  pieceAt,
  defOf,
  kingSquare,
  boardCount,
  decider,
  movesFrom,
  placementSquares,
  battleOutcome,
  kingFallsBy,
  emptyNeighbors,
  legalActions,
  deckCount,
  handCount,
  actionKey,
  createInitialState,
  reduce,
  filterStateFor,
};

root.NECRO_ENGINE = engine;
if (typeof module !== 'undefined' && module.exports) module.exports = engine;

// ===========================================================================
// Node 単体実行時のセルフテスト
//   $ node js/engine.js
// ===========================================================================

const isNodeMain =
  typeof process !== 'undefined' &&
  !!(process.versions && process.versions.node) &&
  typeof process.argv[1] === 'string' &&
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
    if (cond) console.log(`  ok   ${label}`);
    else { console.log(`  FAIL ${label}`); failures++; }
  };
  const throws = (fn) => { try { fn(); return false; } catch (e) { return true; } };
  const deepFreeze = (o) => {
    if (o && typeof o === 'object' && !Object.isFrozen(o)) {
      Object.freeze(o);
      for (const k of Object.keys(o)) deepFreeze(o[k]);
    }
    return o;
  };

  /** 盤を空にして（キングも外して）任意の駒を置いた検査用の state を作る */
  function blank(overrides, opts = {}) {
    let s = createInitialState(opts.seed || 1, cardData, overrides);
    s = { ...s, cells: new Array(s.cells.length).fill(null), pending: [], lastEvents: [] };
    if (opts.kings !== false) {
      s = setCell(s, opts.k1 || 'D7', 'p1-K');
      s = setCell(s, opts.k2 || 'D1', 'p2-K');
    }
    return s;
  }
  /** 山（手札も含む）から kind の駒を1つ抜いて sq に置く。controller を指定できる */
  function put(s, owner, kind, sq, controller) {
    const p = s.players[owner];
    const id = [...p.deck, ...p.hand].find((i) => s.pieces[i].kind === kind && !s.cells.includes(i));
    let t = setPlayer(s, owner, { deck: p.deck.filter((i) => i !== id), hand: p.hand.filter((i) => i !== id) });
    t = setCell(t, sq, id);
    t = setPiece(t, id, { controller: controller || owner });
    return { s: t, id };
  }
  const tos = (s, sq) => movesFrom(s, sq).map((m) => m.to).sort();
  const totalPieces = (s) => {
    let n = 0;
    for (const pid of PLAYERS) n += s.players[pid].deck.length + s.players[pid].hand.length;
    n += boardCount(s);
    for (const p of s.pending) n += p.type === 'draft' ? p.options.length : (s.cells.includes(p.pieceId) ? 0 : 1);
    return n;
  };

  /** 合法手から決定的に選んで最後まで進める（セルフテスト用） */
  function playout(seed, overrides) {
    let s = createInitialState(seed, cardData, overrides);
    let r = createRng(seed ^ 0x5bd1e995);
    const seen = [];
    while (!s.result) {
      const who = decider(s);
      const acts = legalActions(s, who);
      // キングを取れるなら取る、勝てる攻撃を優先、それ以外はランダム
      const kill = acts.find((a) => a.type === 'move' && pieceAt(s, a.to) && pieceAt(s, a.to).kind === 'king' && battleOutcome(s, a.from, a.to) === 'win');
      let a = kill;
      if (!a) {
        const d = nextRandom(r);
        r = d.rng;
        a = acts[Math.floor(d.value * acts.length)];
      }
      seen.push(a);
      s = reduce(s, a);
    }
    return { state: s, actions: seen };
  }

  console.log('engine.js セルフテスト（v0.3 モック1）');

  // --- データ ---
  {
    const list = cardData.pieces.list;
    const total = list.reduce((n, d) => n + d.count, 0);
    check('データ: 山は16枚', total === 16);
    check('データ: flags の既定値が rules と一致する',
      cardData.flags.list.every((f) => f.choices.some((c) => c.value === cardData.rules[f.key])));
    const s0 = createInitialState(1000, cardData);
    check('初期: キングは先手 D7・後手 D1', pieceAt(s0, 'D7').id === 'p1-K' && pieceAt(s0, 'D1').id === 'p2-K');
    check('初期: 盤上はキング2つだけ', boardCount(s0) === 2);
    check('初期: 先手は初期手札3枚＋手番開始の1枚', s0.players.p1.hand.length === 4 && s0.players.p1.deck.length === 12);
    check('初期: 後手は初期手札3枚', s0.players.p2.hand.length === 3 && s0.players.p2.deck.length === 13);
    check('初期: 先手の手番・0手目', s0.active === 'p1' && s0.ply === 0);
  }

  // --- 非破壊性・決定性 ---
  {
    const s0 = deepFreeze(createInitialState(1001, cardData));
    const before = JSON.stringify(s0);
    let ok = true;
    let s = s0;
    try {
      for (let i = 0; i < 60 && !s.result; i++) {
        const a = legalActions(s, decider(s))[0];
        const next = reduce(deepFreeze(s), a);
        s = next;
      }
    } catch (e) { ok = false; console.log(e); }
    check('非破壊: 凍結した state に reduce しても例外が出ない', ok);
    check('非破壊: 元の state が変わっていない', JSON.stringify(s0) === before);
    const a = playout(1234);
    const b = playout(1234);
    check('決定性: 同一シード＋同一手順 → 同一結果', JSON.stringify(a.state) === JSON.stringify(b.state));
    const c = playout(1235);
    check('決定性: 別シード → 別の展開', JSON.stringify(a.state) !== JSON.stringify(c.state));
    let replay = createInitialState(1234, cardData);
    for (const act of a.actions) replay = reduce(replay, JSON.parse(JSON.stringify(act)));
    check('決定性: action を JSON 経由で再生しても同じ結果', JSON.stringify(replay) === JSON.stringify(a.state));
    check('シリアライズ: state が JSON で往復する', JSON.stringify(JSON.parse(JSON.stringify(a.state))) === JSON.stringify(a.state));
  }

  // --- 戦闘 ---
  {
    // 攻撃側が上：防御側が倒れ、攻撃側がそのマスに入る
    let s = blank();
    let t = put(s, 'p1', 'rook', 'A5'); s = t.s; const rook = t.id;
    t = put(s, 'p2', 'pawn', 'A3'); s = t.s; const pawn = t.id;
    s = { ...s, active: 'p1' };
    let n = reduce(s, { type: 'move', from: 'A5', to: 'A3' });
    check('戦闘: 攻撃側が上なら攻撃側がそのマスに入る', pieceAt(n, 'A3').id === rook && !pieceAt(n, 'A5'));
    check('戦闘: 倒された駒は倒した側の駒になる（寝返り待ち）', n.pieces[pawn].controller === 'p1' && n.pending[0].type === 'placeDefector' && n.pending[0].pieceId === pawn);
    check('戦闘: 減らない設定（既定）では勝った駒の強さはそのまま', n.pieces[rook].strength === 4);
    check('戦闘: 倒された回数が1になる', n.pieces[pawn].defeats === 1);

    // 防御側が上：攻撃側が倒れ、防御側はそのまま
    s = blank();
    t = put(s, 'p1', 'pawn', 'B5'); s = t.s; const p1pawn = t.id;
    t = put(s, 'p2', 'rook', 'C4'); s = t.s; const p2rook = t.id;
    s = { ...s, active: 'p1' };
    n = reduce(s, { type: 'move', from: 'B5', to: 'C4' });
    check('戦闘: 防御側が上なら防御側はそのまま', pieceAt(n, 'C4').id === p2rook && !pieceAt(n, 'B5'));
    check('戦闘: 攻撃して負けた駒も倒した側の駒になる', n.pieces[p1pawn].controller === 'p2' && n.pending[0].player === 'p2');

    // 同値なら両方とも元の持ち主の山の底へ還る。ドラフトは起きない
    s = blank();
    t = put(s, 'p1', 'knight', 'C5'); s = t.s; const kn1 = t.id;
    t = put(s, 'p2', 'bishop', 'D3'); s = t.s; const bi2 = t.id;
    s = { ...s, active: 'p1' };
    const deck1 = s.players.p1.deck.length;
    const deck2 = s.players.p2.deck.length;
    n = reduce(s, { type: 'move', from: 'C5', to: 'D3' });
    check('同値: 両方とも盤から消える', !pieceAt(n, 'C5') && !pieceAt(n, 'D3'));
    check('同値: 攻撃側は元の持ち主の山の底へ', n.players.p1.deck[n.players.p1.deck.length - 1] === kn1);
    // p2 は手番開始で1枚引くので、底にいることは「最後の要素」で確かめる
    check('同値: 防御側は元の持ち主の山の底へ', n.players.p2.deck[n.players.p2.deck.length - 1] === bi2 && n.players.p2.deck.length === deck2 + 1 - 1);
    check('同値: ドラフトは起きない', n.stats.drafts === 0 && n.pending.length === 0);
    check('同値: 手番は相手へ', n.active === 'p2' && n.players.p1.deck.length === deck1 + 1);

    // 勝った側の強さが減る設定：負けた側の強さの分だけ減り、手番をまたいで残る
    s = blank({ winnerLosesStrength: true });
    t = put(s, 'p1', 'queen', 'A5'); s = t.s; const q = t.id;
    t = put(s, 'p2', 'knight', 'A2'); s = t.s;
    s = { ...s, active: 'p1' };
    n = reduce(s, { type: 'move', from: 'A5', to: 'A2' });
    check('減る設定: 5 - 3 = 2 になる', n.pieces[q].strength === 2);
    n = reduce(n, legalActions(n, 'p1')[0]);   // 寝返りの配置
    n = reduce(n, { type: 'draftPick', keep: 0 });   // 取られた側(p2)のドラフト
    check('減る設定: 減った値は手番をまたいで残る', n.active === 'p2' && n.pieces[q].strength === 2);
  }

  // --- 寝返り：強さは元に戻る・置き場所・N 回目 ---
  {
    // 減った駒が倒されて寝返ると、強さは元の値に戻る
    let s = blank({ winnerLosesStrength: true });
    let t = put(s, 'p1', 'rook', 'A5'); s = t.s; const rook = t.id;
    s = setPiece(s, rook, { strength: 1 });
    t = put(s, 'p2', 'knight', 'B3'); s = t.s;
    s = { ...s, active: 'p2' };
    let n = reduce(s, { type: 'move', from: 'B3', to: 'A5' });
    check('寝返り: 強さは元の値に戻る', n.pieces[rook].controller === 'p2' && n.pieces[rook].strength === 4);

    // 置き場所（既定）：倒した側のキングの周囲8マスの空きマス
    s = blank({}, { k1: 'D7', k2: 'D1' });
    t = put(s, 'p1', 'rook', 'G5'); s = t.s;
    t = put(s, 'p2', 'pawn', 'G3'); s = t.s;
    s = { ...s, active: 'p1' };
    n = reduce(s, { type: 'move', from: 'G5', to: 'G3' });
    check('置き場所(キング): D7 の周囲の空きマス5つ', JSON.stringify(n.pending[0].squares.slice().sort()) === JSON.stringify(['C6', 'C7', 'D6', 'E6', 'E7']));
    check('置き場所: 置くのは倒した側', decider(n) === 'p1');
    const placed = reduce(n, { type: 'placeDefector', to: 'C6' });
    check('置き場所: 置いても手数は進まない（手番を使わない）', placed.ply === n.ply);
    check('置き場所: 置いたマスに寝返った駒がある', pieceAt(placed, 'C6').controller === 'p1');
    check('置き場所: 候補外のマスには置けない', throws(() => reduce(n, { type: 'placeDefector', to: 'A1' })));

    // 置き場所（もう一方）：勝った駒の周囲8マス
    s = blank({ defectorPlacement: 'winner' });
    t = put(s, 'p1', 'rook', 'G5'); s = t.s;
    t = put(s, 'p2', 'pawn', 'G3'); s = t.s;
    s = { ...s, active: 'p1' };
    n = reduce(s, { type: 'move', from: 'G5', to: 'G3' });
    check('置き場所(勝った駒): G3 の周囲の空きマス5つ', JSON.stringify(n.pending[0].squares.slice().sort()) === JSON.stringify(['F2', 'F3', 'F4', 'G2', 'G4']));

    // 空きがなければ元の持ち主の山へ還る
    s = blank({}, { k1: 'A7' });
    t = put(s, 'p1', 'pawn', 'A6'); s = t.s;
    t = put(s, 'p1', 'pawn', 'B6'); s = t.s;
    t = put(s, 'p1', 'pawn', 'B7'); s = t.s;
    t = put(s, 'p1', 'rook', 'G5'); s = t.s;
    t = put(s, 'p2', 'pawn', 'G3'); s = t.s; const gp = t.id;
    s = { ...s, active: 'p1' };
    n = reduce(s, { type: 'move', from: 'G5', to: 'G3' });
    check('空きなし: 寝返らず元の持ち主の山へ', n.pieces[gp].controller === 'p2' && n.players.p2.deck.includes(gp) && n.stats.returnsNoSpace === 1);

    // N 回目に倒されたときは寝返らず、元の持ち主の山の底へ還る（既定 N=2）
    s = blank();
    t = put(s, 'p1', 'rook', 'G5'); s = t.s;
    t = put(s, 'p2', 'pawn', 'G3'); s = t.s; const twice = t.id;
    s = setPiece(s, twice, { defeats: 1 });
    s = { ...s, active: 'p1' };
    n = reduce(s, { type: 'move', from: 'G5', to: 'G3' });
    check('N 回目: 寝返らない', n.pending.every((p) => p.type !== 'placeDefector') && n.stats.defections === 0);
    check('N 回目: 元の持ち主の山の底へ還る', n.players.p2.deck[n.players.p2.deck.length - 1] === twice);
    check('N 回目: 持ち主・強さ・倒された回数が戻る', n.pieces[twice].controller === 'p2' && n.pieces[twice].defeats === 0 && n.stats.returnsNth === 1);
    // N=3 なら2回目では寝返る
    s = blank({ defeatsToReturn: 3 });
    t = put(s, 'p1', 'rook', 'G5'); s = t.s;
    t = put(s, 'p2', 'pawn', 'G3'); s = t.s; const thrice = t.id;
    s = setPiece(s, thrice, { defeats: 1 });
    s = { ...s, active: 'p1' };
    n = reduce(s, { type: 'move', from: 'G5', to: 'G3' });
    check('N=3: 2回目に倒されても寝返る', n.pieces[thrice].controller === 'p1' && n.pieces[thrice].defeats === 2);
    // 倒された回数を持ち越す設定
    s = blank({ resetDefeatsOnReturn: false });
    t = put(s, 'p1', 'rook', 'G5'); s = t.s;
    t = put(s, 'p2', 'pawn', 'G3'); s = t.s; const keep = t.id;
    s = setPiece(s, keep, { defeats: 1 });
    s = { ...s, active: 'p1' };
    n = reduce(s, { type: 'move', from: 'G5', to: 'G3' });
    check('持ち越し設定: 山へ還っても倒された回数が残る', n.pieces[keep].defeats === 2);
  }

  // --- 元の持ち主の山へ還る（相手の手札に渡った駒・寝返った駒） ---
  {
    let s = blank();
    // p2 の駒が p1 に寝返って p1 の盤上にいる。それが N 回目に倒されると p2 の山へ
    let t = put(s, 'p2', 'knight', 'C5', 'p1'); s = t.s; const turned = t.id;
    s = setPiece(s, turned, { defeats: 1 });
    t = put(s, 'p2', 'rook', 'C3'); s = t.s;
    s = { ...s, active: 'p2' };
    let n = reduce(s, { type: 'move', from: 'C3', to: 'C5' });
    check('元の持ち主: 寝返った駒は元の持ち主(p2)の山へ還る', n.players.p2.deck.includes(turned) && !n.players.p1.deck.includes(turned));
    // 同値で両方還るときも、それぞれ元の持ち主の山へ
    s = blank();
    t = put(s, 'p2', 'knight', 'C5', 'p1'); s = t.s; const t2 = t.id;
    t = put(s, 'p1', 'bishop', 'D3', 'p2'); s = t.s; const t3 = t.id;
    s = { ...s, active: 'p1' };
    n = reduce(s, { type: 'move', from: 'C5', to: 'D3' });
    check('元の持ち主: 同値でも元の持ち主の山へ（p2 の駒 → p2）', n.players.p2.deck.includes(t2));
    check('元の持ち主: 同値でも元の持ち主の山へ（p1 の駒 → p1）', n.players.p1.deck.includes(t3));
    // ドラフトで相手の手札へ渡った駒を置いて、それが山へ還るとき
    s = blank();
    t = put(s, 'p1', 'pawn', 'A1'); s = t.s;          // 後で使わない
    s = setCell(s, 'A1', null);
    const gift = t.id;                                  // p1 の駒を p2 の手札に入れる
    s = setPlayer(s, 'p2', { hand: [...s.players.p2.hand, gift] });
    s = { ...s, active: 'p2' };
    n = reduce(s, { type: 'place', pieceId: gift, to: 'G1' });
    check('元の持ち主: 相手の手札から置かれた駒の持ち主は置いた側、元の持ち主は変わらない', n.pieces[gift].controller === 'p2' && n.pieces[gift].owner === 'p1');
    let u = setPiece(n, gift, { defeats: 1 });
    t = put(u, 'p1', 'rook', 'G5'); u = t.s;
    u = { ...u, active: 'p1', pending: [] };
    const m = reduce(u, { type: 'move', from: 'G5', to: 'G1' });
    check('元の持ち主: その駒が山へ還るのは元の持ち主(p1)の山', m.players.p1.deck.includes(gift) && !m.players.p2.deck.includes(gift));
  }

  // --- ポーン ---
  {
    let s = blank();
    let t = put(s, 'p1', 'pawn', 'C5'); s = t.s;
    t = put(s, 'p2', 'pawn', 'C4'); s = t.s;          // 正面は塞がれている
    t = put(s, 'p2', 'pawn', 'D4'); s = t.s;          // 斜め前の敵
    t = put(s, 'p2', 'pawn', 'B6'); s = t.s;          // 斜め後ろの敵（取れない）
    s = { ...s, active: 'p1' };
    check('ポーン: 正面の駒は取れない・斜め前だけで取る', JSON.stringify(tos(s, 'C5')) === JSON.stringify(['D4']));
    const s2 = setCell(s, 'C4', null);
    check('ポーン: 前に1マス進む（2マス進みはない）', JSON.stringify(tos(s2, 'C5')) === JSON.stringify(['C4', 'D4']));
    // 後手のポーンは行が増える向きが前
    check('ポーン: 後手の前は行が増える向き', JSON.stringify(tos(s, 'D4')) === JSON.stringify(['C5', 'D5']));
    // 寝返ると向きが反転する（p2 のポーンが p1 のものになると、行が減る向きへ）
    const s3 = setPiece(s, pieceAt(s, 'D4').id, { controller: 'p1' });
    const s4 = setCell(setCell(s3, 'C5', null), 'C4', null);
    check('ポーン: 寝返ると向きが反転する', JSON.stringify(tos(s4, 'D4')) === JSON.stringify(['D3']));
    // 最奥で前がなければ動けない（昇格なし）
    let e = blank({}, { k2: 'G1' });
    t = put(e, 'p1', 'pawn', 'B1'); e = t.s;
    check('ポーン: 敵陣の最奥では動けない（昇格なし）', tos(e, 'B1').length === 0);
  }

  // --- 飛び越え ---
  {
    let s = blank();
    let t = put(s, 'p1', 'knight', 'D4'); s = t.s;
    for (const sq of ['C3', 'D3', 'E3', 'C4', 'E4', 'C5', 'D5', 'E5']) { t = put(s, 'p1', 'pawn', sq); s = t.s; }
    check('ナイト: 周りを囲まれても8方向に跳べる（飛び越える）', tos(s, 'D4').length === 8);
    t = put(s, 'p1', 'rook', 'A4'); s = t.s;
    t = put(s, 'p1', 'bishop', 'A1'); s = t.s;
    t = put(s, 'p1', 'queen', 'G7'); s = t.s;
    check('ルーク: 味方の駒を飛び越えない', JSON.stringify(tos(s, 'A4')) === JSON.stringify(['A2', 'A3', 'A5', 'A6', 'A7', 'B4']));
    check('ビショップ: 途中の駒で止まる', JSON.stringify(tos(s, 'A1')) === JSON.stringify(['B2']));
    check('クイーン: 途中の駒で止まり、距離の上限はない', tos(s, 'G7').includes('G1') && tos(s, 'G7').includes('F6') && !tos(s, 'G7').includes('B2'));
    let r = blank();
    t = put(r, 'p1', 'rook', 'A7'); r = t.s;
    t = put(r, 'p2', 'pawn', 'A4'); r = t.s;
    t = put(r, 'p2', 'pawn', 'A2'); r = t.s;
    check('ルーク: 敵の駒は取れるが、その先へは行けない', JSON.stringify(tos(r, 'A7').filter((x) => x[0] === 'A')) === JSON.stringify(['A4', 'A5', 'A6']));
  }

  // --- 配置範囲 ---
  {
    const s = createInitialState(1002, cardData);
    const byKind = (pid, kind) => [...s.players[pid].hand, ...s.players[pid].deck].find((i) => s.pieces[i].kind === kind);
    const rows = (sqs) => Array.from(new Set(sqs.map((q) => q.slice(1)))).sort().join('');
    check('配置: 範囲0（ルーク）は先手の最奥列 7 だけ・キングのマスを除く6マス',
      rows(placementSquares(s, 'p1', byKind('p1', 'rook'))) === '7' && placementSquares(s, 'p1', byKind('p1', 'rook')).length === 6);
    check('配置: 範囲1（ナイト）は奥の2列（6・7行）', rows(placementSquares(s, 'p1', byKind('p1', 'knight'))) === '67');
    check('配置: 範囲2（ポーン）は奥の3列（5〜7行）・中央列には届かない', rows(placementSquares(s, 'p1', byKind('p1', 'pawn'))) === '567');
    check('配置: 後手の範囲2は 1〜3行', rows(placementSquares(s, 'p2', byKind('p2', 'pawn'))) === '123');
    const handPawn = s.players.p1.hand.find((i) => s.pieces[i].kind === 'pawn') || s.players.p1.hand[0];
    const sq = placementSquares(s, 'p1', handPawn)[0];
    const n = reduce(s, { type: 'place', pieceId: handPawn, to: sq });
    check('配置: 置くと1手進み、手番が相手へ', n.ply === 1 && n.active === 'p2' && pieceAt(n, sq).id === handPawn);
    check('配置: 埋まったマスには置けない', !placementSquares(n, 'p2', n.players.p2.hand[0]).includes('D1'));
    check('配置: 範囲外には置けない', throws(() => reduce(s, { type: 'place', pieceId: handPawn, to: 'D4' })));
  }

  // --- 取られた側ドラフト ---
  {
    let s = blank();
    let t = put(s, 'p1', 'rook', 'G5'); s = t.s;
    t = put(s, 'p2', 'pawn', 'G3'); s = t.s;
    s = { ...s, active: 'p1' };
    const top2 = s.players.p2.deck.slice(0, 2);
    let n = reduce(s, { type: 'move', from: 'G5', to: 'G3' });
    check('ドラフト: 寝返りの配置 → 取られた側(p2)のドラフトの順に保留される', n.pending.length === 2 && n.pending[1].type === 'draft' && n.pending[1].player === 'p2');
    check('ドラフト: 山の上から2枚', JSON.stringify(n.pending[1].options) === JSON.stringify(top2));
    n = reduce(n, { type: 'placeDefector', to: n.pending[0].squares[0] });
    const h1 = n.players.p1.hand.length;
    const h2 = n.players.p2.hand.length;
    n = reduce(n, { type: 'draftPick', keep: 1 });
    check('ドラフト: 選んだ1枚は自分の手札へ', n.players.p2.hand.includes(top2[1]));
    check('ドラフト: もう1枚は相手の手札へ', n.players.p1.hand.includes(top2[0]) && n.players.p1.hand.length === h1 + 1);
    check('ドラフト: 手番を使わない（手数は1のまま、そのあと p2 の手番が始まる）', n.ply === 1 && n.active === 'p2' && n.players.p2.hand.length === h2 + 1 + 1);
    check('ドラフト: 渡った駒の元の持ち主は p2 のまま', n.pieces[top2[0]].owner === 'p2');
    // 山が1枚なら自分の手札へ、空なら何もしない
    s = blank();
    t = put(s, 'p1', 'rook', 'G5'); s = t.s;
    t = put(s, 'p2', 'pawn', 'G3'); s = t.s;
    s = setPlayer(s, 'p2', { deck: s.players.p2.deck.slice(0, 1), hand: [] });
    const only = s.players.p2.deck[0];
    s = { ...s, active: 'p1' };
    n = reduce(s, { type: 'move', from: 'G5', to: 'G3' });
    check('ドラフト: 山が1枚ならその1枚を自分の手札へ（保留しない）', n.players.p2.hand.includes(only) && n.pending.length === 1 && n.stats.drafts === 1);
    s = setPlayer(s, 'p2', { deck: [] });
    n = reduce(s, { type: 'move', from: 'G5', to: 'G3' });
    check('ドラフト: 山が空なら何もしない', n.stats.drafts === 0 && n.pending.every((p) => p.type !== 'draft'));
    // 防御側が勝ったときは攻撃側がドラフト
    s = blank();
    t = put(s, 'p1', 'pawn', 'B5'); s = t.s;
    t = put(s, 'p2', 'rook', 'C4'); s = t.s;
    s = { ...s, active: 'p1' };
    n = reduce(s, { type: 'move', from: 'B5', to: 'C4' });
    check('ドラフト: 攻撃して負けた側(p1)がドラフトする', n.pending.some((p) => p.type === 'draft' && p.player === 'p1'));
  }

  // --- キングを倒したら決着 ---
  {
    let s = blank();
    let t = put(s, 'p1', 'rook', 'D5'); s = t.s;
    s = setCell(s, 'D1', null);
    s = setCell(s, 'D3', 'p2-K');
    s = { ...s, active: 'p1' };
    const n = reduce(s, { type: 'move', from: 'D5', to: 'D3' });
    check('決着: キングを倒したら勝ち', n.result && n.result.winner === 'p1' && n.result.reason === 'king');
    check('決着: キングは寝返らない（保留なし）', n.pending.length === 0);
    check('決着: 決着後は合法手がない', legalActions(n, 'p1').length === 0 && legalActions(n, 'p2').length === 0);
    check('決着: 決着後の action は拒否される', throws(() => reduce(n, { type: 'pass' })));
    // キングが攻撃して負けても決着
    let k = blank();
    t = put(k, 'p2', 'rook', 'D6'); k = t.s;
    k = { ...k, active: 'p1' };
    const kn = reduce(k, { type: 'move', from: 'D7', to: 'D6' });
    check('決着: キングが攻撃して負けても決着', kn.result && kn.result.winner === 'p2');
    // キングと同値（既定 kingFalls）
    let tie = blank();
    t = put(tie, 'p1', 'knight', 'C3'); tie = t.s;
    tie = { ...tie, active: 'p1' };
    const tn = reduce(tie, { type: 'move', from: 'C3', to: 'D1' });
    check('キング同値(既定): キングは倒れて決着', tn.result && tn.result.winner === 'p1');
    let tie2 = blank({ kingTie: 'kingSurvives' });
    t = put(tie2, 'p1', 'knight', 'C3'); tie2 = t.s; const kid = t.id;
    tie2 = { ...tie2, active: 'p1' };
    const tn2 = reduce(tie2, { type: 'move', from: 'C3', to: 'D1' });
    check('キング同値(kingSurvives): キングは残り、相手の駒だけ山へ', !tn2.result && pieceAt(tn2, 'D1').id === 'p2-K' && tn2.players.p1.deck.includes(kid));
  }

  // --- 手番・引き方・200手 ---
  {
    const s = createInitialState(1003, cardData, { drawMode: 'action' });
    check('引き方(行動): 開始時に引かない', s.players.p1.hand.length === 3);
    check('引き方(行動): 引くことが合法手に入る', legalActions(s, 'p1').some((a) => a.type === 'draw'));
    const n = reduce(s, { type: 'draw' });
    check('引き方(行動): 引くと1手使う', n.ply === 1 && n.active === 'p2' && n.players.p1.hand.length === 4 && n.players.p2.hand.length === 3);
    const d = createInitialState(1003, cardData);
    check('引き方(既定): 引くは合法手に入らない', !legalActions(d, 'p1').some((a) => a.type === 'draw'));
    const end = playout(1004, { maxPlies: 6 });
    check('打ち切り: maxPlies に達したら引き分け', end.state.result.ply <= 6 && (end.state.result.reason !== 'maxPlies' || end.state.result.winner === null));
    const long = createInitialState(1004, cardData, { maxPlies: 2 });
    const l1 = reduce(long, legalActions(long, 'p1').find((a) => a.type === 'place'));
    const l2 = reduce(l1, legalActions(l1, 'p2').find((a) => a.type === 'place'));
    check('打ち切り: 2手で引き分け（maxPlies=2）', l2.result && l2.result.winner === null && l2.result.reason === 'maxPlies' && l2.ply === 2);
    check('手番: 1手番に1行動（手番の側以外は指せない）', legalActions(d, 'p2').length === 0);
    // 合法手がなければ pass だけ（キング A1 を自分のポーンで囲み、ポーンも動けない形）
    let p = blank({}, { k1: 'A1', k2: 'G7' });
    p = setPlayer(p, 'p1', { hand: [] });
    for (const sq of ['A2', 'B2', 'B1']) { const t = put(p, 'p1', 'pawn', sq); p = t.s; }
    p = { ...p, active: 'p1' };
    const la = legalActions(p, 'p1');
    check('手番: 動かせる駒も手札もなければ pass だけ', la.length === 1 && la[0].type === 'pass');
    const pn = reduce(p, { type: 'pass' });
    check('手番: pass は1手として数え、手番を渡す', pn.ply === 1 && pn.active === 'p2');
  }

  // --- 自動対戦の不変条件 ---
  {
    let ok = true;
    let total = true;
    for (let seed = 2000; seed < 2030; seed++) {
      let s = createInitialState(seed, cardData);
      let r = createRng(seed);
      while (!s.result) {
        const acts = legalActions(s, decider(s));
        const d = nextRandom(r); r = d.rng;
        s = reduce(s, acts[Math.floor(d.value * acts.length)]);
        if (!s.result && totalPieces(s) !== 34) total = false;
        for (const id of s.cells) if (id && s.pieces[id].kind !== 'king' && s.pieces[id].defeats >= s.rules.defeatsToReturn) ok = false;
      }
    }
    check('不変条件: 駒の総数（山・手札・盤・保留）は常に34（山16×2＋キング2）', total);
    check('不変条件: 盤上の駒の倒された回数は N 未満', ok);
  }

  // --- 視点フィルタ ---
  {
    let sawDraft = false;
    let leaked = false;
    let legalSame = true;
    let run = null;
    for (let seed = 1005; seed < 1025; seed++) {
      run = playout(seed);
      let s = createInitialState(seed, cardData);
      for (const a of run.actions) {
        for (const viewer of PLAYERS) {
          const v = filterStateFor(s, viewer);
          const opp = opponentOf(viewer);
          const json = JSON.stringify(v);
          if (v.players[opp].hand !== null) leaked = true;
          if (v.players.p1.deck !== undefined || v.players.p2.deck !== undefined) leaked = true;
          if (v.rng !== undefined) leaked = true;
          for (const id of s.players[opp].hand) if (json.includes(`"${id}"`)) leaked = true;
          for (const pid of PLAYERS) for (const id of s.players[pid].deck) if (json.includes(`"${id}"`)) leaked = true;
          for (const p of s.pending) {
            if (p.type === 'draft' && p.player !== viewer) {
              sawDraft = true;
              for (const id of p.options) if (json.includes(`"${id}"`)) leaked = true;
            }
          }
          if (decider(s) === viewer) {
            const a1 = legalActions(s, viewer).map(actionKey).join(',');
            const a2 = legalActions(v, viewer).map(actionKey).join(',');
            if (a1 !== a2) legalSame = false;
          }
        }
        s = reduce(s, a);
      }
    }
    check('フィルタ: 相手の手札の中身が含まれない（id も出ない）', !leaked);
    check('フィルタ: 両者の山の中身が含まれない（枚数のみ）', !leaked);
    check('フィルタ: 相手がドラフトで見ている2枚が含まれない', sawDraft && !leaked);
    check('フィルタ: フィルタ後の state でも本人の合法手は同じ', legalSame);
    const v = filterStateFor(run.state, 'p1');
    check('フィルタ: 枚数は見える', typeof v.players.p2.handCount === 'number' && typeof v.players.p1.deckCount === 'number');
    check('フィルタ: 自分の手札は見える', Array.isArray(v.players.p1.hand));
    const spectator = filterStateFor(run.state, null);
    check('フィルタ: 観戦者には両者の手札とも見えない', spectator.players.p1.hand === null && spectator.players.p2.hand === null);
  }

  // --- ソース検査（Math.random 不使用・file:// で開けること・CG-008 踏襲） ---
  {
    const banned = new RegExp(['Math', '\\.', 'random'].join(''));
    const esm = /^\s*(import|export)\s/m;
    const fetchCall = new RegExp(['fetch', '\\s*\\('].join(''));
    const stripComments = (t) => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
    for (const rel of ['engine.js', 'view.js', 'ai.js']) {
      const code = stripComments(readFileSync(path.join(here, rel), 'utf8'));
      check(`${rel}: ${'Math'}.random を使っていない`, !banned.test(code));
      check(`${rel}: ES モジュール構文を使っていない`, !esm.test(code));
      check(`${rel}: ${'fetch'} を使っていない`, !fetchCall.test(code));
    }
    const html = readFileSync(path.join(here, '..', 'index.html'), 'utf8').replace(/<!--[\s\S]*?-->/g, '');
    check('index.html: script に type="module" を付けていない', !/type\s*=\s*"module"/.test(html));
    for (const rel of ['data/cards.js', 'data/ai.js', 'js/engine.js', 'js/ai.js', 'js/view.js']) {
      check(`index.html: ${rel} を読み込んでいる`, html.includes(`src="${rel}"`));
    }
    const pkg = JSON.parse(readFileSync(path.join(here, '..', 'package.json'), 'utf8'));
    check('package.json: type を書いていない（CommonJS のまま）', pkg.type === undefined);
    // 駒の数値をベタ書きしていない（data の名前がコードに現れない）
    const eng = stripComments(readFileSync(path.join(here, 'engine.js'), 'utf8')).split('if (isNodeMain)')[0];
    check('engine.js: 駒の種類名で分岐していない（king 以外）', !/'(pawn|knight|bishop|rook|queen)'/.test(eng));
  }

  console.log(failures === 0 ? `\n${checks} 件すべて成功` : `\n${checks} 件中 ${failures} 件失敗`);
  if (failures > 0) process.exit(1);
}

})(typeof globalThis !== 'undefined' ? globalThis : this);

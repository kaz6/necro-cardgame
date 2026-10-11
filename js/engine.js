/**
 * engine.js — 純粋なゲームロジック（v0.3 モック1・CG-021 ＋ モック2・CG-023）
 *
 * 【不可逆制約】詳細は CLAUDE.md
 *   - DOM / window / document に一切触らない。Node 単体で実行できること
 *   - (state, action) => newState の純粋関数。既存 state を破壊的に変更しない
 *   - action は JSON 化可能なオブジェクトのみ
 *   - filterStateFor(state, playerId) で相手の手札と両者の山の中身を落とす
 *   - 乱数は下記 seeded RNG のみ。Math.random() 禁止
 *   - 駒の数値・動き・ルールフラグは data/cards.js。ここにベタ書きしない
 *
 * 【仕様の正本】Notion CURRENT_SPEC「v0.3 モック1 仕様」「v0.3 モック2 追加仕様」
 *   7×7・キングだけの空の盤から育てる・1手番1行動・強さ1値の戦闘・寝返り・
 *   N 回目に倒されたら元の持ち主の山へ・取られた側ドラフト。
 *   モック2：実際の強さ（基礎＋常時の効果）と能力8種。能力の中身は data の abilities にあり、
 *   engine は発火点と効果の型（EFFECTS 表）だけを知っている。打つ前の結果予測（previewMove）は
 *   実際の解決と同じ resolveMove を通る。
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

/** 盤上の駒 id のマス（盤上にいなければ null） */
function pieceSquare(state, id) {
  const i = state.cells.indexOf(id);
  return i < 0 ? null : squareName(state, i % state.board.cols, Math.floor(i / state.board.cols) + 1);
}

// ===========================================================================
// 能力と実際の強さ（モック2・CG-023）
//   ★ 能力の中身は data/cards.js の abilities。engine は「発火点（trigger）」と
//     「効果の型（effect）」だけを知っている。能力の id（鼓舞・押し出し…）で分岐しない。
//   新しい能力：既存の trigger・effect の組み合わせなら data に1行足すだけ。
//   新しい効果の型：下の EFFECTS 表に1つ足す（解決の流れ resolveBattle は変えない）。
// ===========================================================================

/** 駒の能力（data の abilities の1件に id を足したもの）。能力なしなら null */
function abilityOf(state, piece) {
  const id = defOf(state, piece).ability;
  return id ? state.abilities[id] || null : null;
}

/** source のマスから見て target のマスが area の範囲に入るか */
function inArea(state, areaKey, sourceSq, targetSq) {
  const a = parseSquare(state, sourceSq);
  const b = parseSquare(state, targetSq);
  return (state.areas[areaKey] || []).some(([dx, dy]) => a.x + dx === b.x && a.y + dy === b.y);
}

/** sq を中心に area の範囲にある盤上のマス */
function areaSquares(state, areaKey, sq) {
  const c = parseSquare(state, sq);
  const out = [];
  for (const [dx, dy] of state.areas[areaKey] || []) {
    if (inBoard(state, c.x + dx, c.y + dy)) out.push(squareName(state, c.x + dx, c.y + dy));
  }
  return out;
}

/**
 * 効果の型の表。
 *   strength(state, ability, source, sourceSq, target, targetSq) … 常時の効果：target の実際の強さに足す値
 *   blocksPush                                                   … 常時の効果：押し出しで押されない
 *   fire(ctx, ability, pieceId, info)                            … 発火点のある効果：解決中の ctx を進める
 */
const EFFECTS = {
  aura: {
    strength(state, ab, src, srcSq, tgt, tgtSq) {
      if (src.id === tgt.id) return 0;   // 自分は含まない
      const ally = src.controller === tgt.controller;
      if (ab.affects === 'allies' && !ally) return 0;
      if (ab.affects === 'enemies' && ally) return 0;
      return inArea(state, ab.area, srcSq, tgtSq) ? ab.amount : 0;
    },
  },
  immovable: { blocksPush: true },
  gainBase: {
    fire(ctx, ab, pieceId) {
      const pc = ctx.s.pieces[pieceId];
      const to = Math.max(0, pc.strength + ab.amount);
      ctx.s = setPiece(ctx.s, pieceId, { strength: to });
      ctx.events.push({ type: 'baseChange', abilityId: ab.id, changes: [{ pieceId, from: pc.strength, to }] });
    },
  },
  areaBase: {
    fire(ctx, ab, pieceId, info) {
      const at = ab.at === 'defeatedSquare' ? info.defeatedSq : pieceSquare(ctx.s, pieceId);
      if (!at) return;
      const changes = [];
      for (const sq of areaSquares(ctx.s, ab.area, at)) {
        const pc = pieceAt(ctx.s, sq);
        if (!pc || pc.id === pieceId) continue;
        if (ab.affects === 'formerAllies' && pc.controller !== info.formerSide) continue;
        const to = Math.max(0, pc.strength + ab.amount);
        changes.push({ pieceId: pc.id, sq, from: pc.strength, to });
        ctx.s = setPiece(ctx.s, pc.id, { strength: to });
      }
      ctx.events.push({ type: 'baseChange', abilityId: ab.id, at, changes });
    },
  },
  ownerDraws: {
    fire(ctx, ab, pieceId) {
      const owner = ctx.s.pieces[pieceId].owner;
      ctx.events.push({ type: 'abilityDraw', abilityId: ab.id, player: owner, count: ab.count });
      if (ctx.preview) return;   // 山と手札は盤に影響しない（予測では動かさない）
      for (let i = 0; i < ab.count; i++) ctx.s = drawOne(ctx.s, owner);
    },
  },
  push: {
    fire(ctx, ab, pieceId, info) { pushFrom(ctx, ab, pieceId, info.from, info.to); },
  },
};

/**
 * 実際の強さとその内訳（盤上の sq の駒）。
 *   base … 基礎の強さ（カードの初期値から始まり、凱歌・裏切り者・「勝った側が減る」で増減する）
 *   parts … 常時の効果（どの駒のどの能力でいくつ）。盤上の位置で毎回計算し直す
 *   total … max(0, base + 常時の効果の合計)
 */
function strengthBreakdown(state, sq) {
  const piece = pieceAt(state, sq);
  if (!piece) return null;
  const parts = [];
  for (let i = 0; i < state.cells.length; i++) {
    const id = state.cells[i];
    if (!id || id === piece.id) continue;
    const src = state.pieces[id];
    const ab = abilityOf(state, src);
    if (!ab || ab.trigger !== 'static') continue;
    const fx = EFFECTS[ab.effect];
    if (!fx || !fx.strength) continue;
    const srcSq = squareName(state, i % state.board.cols, Math.floor(i / state.board.cols) + 1);
    const amount = fx.strength(state, ab, src, srcSq, piece, sq);
    if (amount) parts.push({ abilityId: ab.id, sourceId: src.id, from: srcSq, amount });
  }
  const sum = parts.reduce((n, p) => n + p.amount, 0);
  return {
    pieceId: piece.id,
    base: piece.strength,
    initial: state.defs[piece.kind].strength,
    parts,
    total: Math.max(0, piece.strength + sum),
  };
}

/** 盤上の sq の駒の実際の強さ（戦闘・表示・CPU はすべてこれを使う） */
function effectiveStrength(state, sq) {
  const b = strengthBreakdown(state, sq);
  return b ? b.total : null;
}

/** 押し出しで押されないか（常時の効果 blocksPush） */
function blocksPush(state, piece) {
  const ab = abilityOf(state, piece);
  return !!(ab && ab.trigger === 'static' && EFFECTS[ab.effect] && EFFECTS[ab.effect].blocksPush);
}

/** 戦闘の結果予想（実際の強さ）：'win'（攻撃側が上）| 'lose'（防御側が上）| 'tie' | null（攻撃ではない） */
function battleOutcome(state, from, to) {
  const a = pieceAt(state, from);
  const d = pieceAt(state, to);
  if (!a || !d || a.controller === d.controller) return null;
  const as = effectiveStrength(state, from);
  const ds = effectiveStrength(state, to);
  if (as > ds) return 'win';
  if (as < ds) return 'lose';
  return 'tie';
}

/**
 * その移動で倒れるキングの持ち主（'p1' | 'p2' | 'both' | null）。
 * ★ 押し出しの連鎖の先で倒れるキングも含む（previewMove＝実際の解決と同じ関数で読む）。
 * ★ 同値でキングが絡むときの扱い（rules.kingTie）もここで判定する。AI・view はこれに訊く。
 */
function kingFallsBy(state, from, to) {
  if (!battleOutcome(state, from, to)) return null;
  const r = previewMove(state, from, to).result;
  if (!r) return null;
  if (r.reason === 'bothKings') return 'both';
  return opponentOf(r.winner);
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
    if (p.type === 'placeDefector') return (p.squares || []).map((to) => ({ type: 'placeDefector', to }));
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
 * 既定の設定（デバッグパネルの各項目の既定値もここから引く）。
 * data の rules に、rules の外にある数値の項目を足したもの。
 *   kingStrength … キングの強さ。★ 正本は data の king.strength。ここはそれを写すだけ（CG-022）
 */
function defaultSettings(cardData) {
  const rules = { ...cardData.rules, kingStrength: cardData.king.strength };
  delete rules._note;
  return rules;
}

/** data の表から _note を除いて写す（each で各項目を加工できる） */
function tableOf(obj, each) {
  const out = {};
  for (const key of Object.keys(obj || {})) {
    if (key[0] === '_') continue;
    out[key] = each ? each(key, obj[key]) : obj[key];
  }
  return out;
}

/**
 * @param {number} seed
 * @param {object} cardData data/cards.js の中身
 * @param {object} [ruleOverrides] rules の上書き（デバッグパネル・比較測定用。data は書き換えない）
 */
function createInitialState(seed, cardData, ruleOverrides) {
  const rules = { ...defaultSettings(cardData), ...(ruleOverrides || {}) };
  const set = cardData.pieceSets[rules.pieceSet];
  if (!set || rules.pieceSet[0] === '_') throw new Error(`駒構成がありません: ${rules.pieceSet}`);
  const abilities = tableOf(cardData.abilities, (id, a) => ({ id, ...a }));
  const areas = tableOf(cardData.areas);
  const defs = {};
  for (const d of set.list) {
    if (d.ability && !abilities[d.ability]) throw new Error(`能力がありません: ${d.ability}`);
    defs[d.kind] = { kind: d.kind, move: d.move, strength: d.strength, range: d.range, ability: d.ability || null, short: d.short, symbol: d.symbol };
  }
  const k = cardData.king;
  defs[k.kind] = { kind: k.kind, move: k.move, strength: rules.kingStrength, range: null, ability: null, short: k.short, symbol: k.symbol };
  const moveTypes = tableOf(cardData.moveTypes);
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
    for (const d of set.list) for (let i = 0; i < d.count; i++) kinds.push(d.kind);
    const sh = shuffle(kinds, rng);
    rng = sh.rng;
    // ★ id はシャッフル後の位置で振る（id から種類が推測できないように）
    const deck = sh.items.map((kind, i) => {
      const id = `${pid}-${String(i).padStart(2, '0')}`;
      pieces[id] = { id, kind, owner: pid, controller: pid, strength: defs[kind].strength, defeats: 0 };
      return id;
    });
    const kingId = `${pid}-K`;
    pieces[kingId] = { id: kingId, kind: k.kind, owner: pid, controller: pid, strength: rules.kingStrength, defeats: 0 };
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
    abilities,
    areas,
    cells: new Array(board.cols * board.rows).fill(null),
    pieces,
    players,
    active: 'p1',
    ply: 0,
    pending: [],
    result: null,
    stats: emptyStats(abilities),
    lastEvents: [],
  };
  const cells = state.cells.slice();
  for (const pid of PLAYERS) cells[squareIndex(state, k.start[pid])] = `${pid}-K`;
  state = { ...state, cells };
  // 先手の最初の手番の開始時にも引く（仕様の文言どおり「手番の開始時」）。★ 曖昧な点の仮決め（rules.firstTurnDraw）
  if (!rules.firstTurnDraw) return state;
  return startTurn(state, 'p1', []);
}

function emptyStats(abilities) {
  return {
    moves: 0,
    places: 0,
    draws: 0,
    passes: 0,
    battles: 0,
    chainBattles: 0,
    ties: 0,
    defections: 0,
    returnsNth: 0,
    returnsTie: 0,
    returnsNoSpace: 0,
    returnsFriendly: 0,
    returnsPushedOff: 0,
    drafts: 0,
    pushChains: 0,
    pushedPieces: 0,
    pushOffBoard: 0,
    // 能力ごとの発動回数。常時の効果（鼓舞・槍衾・威圧）は「戦闘に参加した駒の実際の強さに効いた回数」、
    // 不動は「押し出しを止めた回数」、それ以外は発火点で発動した回数
    fires: tableOf(abilities, () => 0),
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
    case 'move': return afterMainAction(settlePending(resolveMove(state, action.from, action.to, false).state));
    case 'place': return afterMainAction(doPlace(state, action));
    case 'draw': return afterMainAction(doDrawAction(state));
    case 'pass': return afterMainAction(addStat({ ...state, lastEvents: [{ type: 'pass', player: who }] }, 'passes'));
    case 'placeDefector': return advanceIfDone(settlePending(doPlaceDefector(state, action)));
    case 'draftPick': return advanceIfDone(settlePending(doDraftPick(state, action)));
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

function addFire(state, abilityId) {
  const fires = state.stats.fires || {};
  return { ...state, stats: { ...state.stats, fires: { ...fires, [abilityId]: (fires[abilityId] || 0) + 1 } } };
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

// ===========================================================================
// 移動・戦闘・能力の解決（CG-023）
//
// ★ 実際の解決（reduce）と、打つ前の結果予測（previewMove）は同じ resolveMove を通る。
//   違いは preview のとき山・手札を動かさない（遺言で引く・山へ入れる・ドラフト）ことだけで、
//   これらは盤に影響しないので、盤の結果は必ず一致する（セルフテストと自動対戦で検査）。
//
// 戦闘1回の解決順（★ 仕様にない「同じ時に複数の能力が発動するとき」の順番。SESSION_STATE 判断待ち）
//   1. 勝敗の判定：実際の強さで比べる（攻撃側は動く前のマス、防御側はその時点）。常時の効果はここで効く
//   2. 同値：攻撃側 → 防御側の順に元の持ち主の山の底へ（それぞれ【山へ還るとき】）。ドラフトなし。終わり
//   3. 盤の更新：負けた駒を盤から除く。攻撃側が勝てばそのマスへ入る
//   4. 「勝った側が減る」（フラグ）：勝った駒の基礎 −= 負けた駒の実際の強さ（1. の値）
//   5. キングが倒れていれば決着（以降は解決しない）
//   6. 負けた駒の行き先：N 回目／同じ持ち主どうし → 山へ【山へ還るとき】／
//      寝返り【寝返り時】／置き場所がない → 山へ【山へ還るとき】
//   7. 勝った駒の【勝利時】
//   8. 取られた側ドラフトを保留に積む
//   9. 攻撃側が勝ったなら【攻めて勝ったとき】（押し出し → 連鎖の各段で 1〜9 を繰り返す）
//   10. 保留（寝返りの配置・ドラフト）は積んだ順に、手番を使わずに解決する
// ===========================================================================

/** 解決中の文脈。s は不変の state を差し替えていく（既存の state は書き換えない） */
function makeCtx(state, preview) {
  return { s: state, events: [], moved: new Set(), preview: !!preview, chain: null, actor: state.active };
}

/** 発火点 trigger で piece の能力を発動する（能力がなければ何もしない） */
function fireTrigger(ctx, trigger, pieceId, info) {
  if (ctx.s.result) return;
  const ab = abilityOf(ctx.s, ctx.s.pieces[pieceId]);
  if (!ab || ab.trigger !== trigger) return;
  const fx = EFFECTS[ab.effect];
  if (!fx || !fx.fire) return;
  ctx.s = addFire(ctx.s, ab.id);
  ctx.events.push({ type: 'ability', abilityId: ab.id, trigger, pieceId });
  fx.fire(ctx, ab, pieceId, info || {});
}

const RETURN_STAT = { nth: 'returnsNth', tie: 'returnsTie', noSpace: 'returnsNoSpace', friendly: 'returnsFriendly', pushedOff: 'returnsPushedOff' };

/**
 * 元の持ち主の山の底へ還す（盤からはすでに除かれていること）。
 * 基礎の強さは初期値・持ち主は元の持ち主に戻る。【山へ還るとき】を発動する。
 */
function returnPiece(ctx, id, why, extra) {
  const pc = ctx.s.pieces[id];
  const patch = { controller: pc.owner, strength: ctx.s.defs[pc.kind].strength };
  if (ctx.s.rules.resetDefeatsOnReturn) patch.defeats = 0;
  ctx.s = setPiece(ctx.s, id, patch);
  const before = ctx.s.rules.onReturnTiming === 'beforeReturn';
  if (before) fireTrigger(ctx, 'onReturn', id);
  if (!ctx.preview) ctx.s = setPlayer(ctx.s, pc.owner, { deck: [...ctx.s.players[pc.owner].deck, id] });
  ctx.s = addStat(ctx.s, RETURN_STAT[why]);
  ctx.events.push({ type: 'return', pieceId: id, owner: pc.owner, why, ...(extra || {}) });
  if (!before) fireTrigger(ctx, 'onReturn', id);
}

/** 決着 */
function endGame(ctx, result) {
  ctx.s = { ...ctx.s, result: { ...result, ply: ctx.s.ply + 1 } };
}

/** 寝返った駒の置き場所の起点のマス（保留を解決する時点の盤で決める） */
function anchorSquare(state, anchor) {
  if (anchor.type === 'king') return kingSquare(state, anchor.player);
  return pieceSquare(state, anchor.pieceId);
}

/** 負けた駒が寝返る（置き場所がなければ山へ） */
function defect(ctx, loser, winner, defeatedSq) {
  const gainSide = winner.controller;
  const formerSide = loser.controller;
  ctx.s = setPiece(ctx.s, loser.id, { controller: gainSide, strength: ctx.s.defs[loser.kind].strength });
  const anchor = ctx.s.rules.defectorPlacement === 'winner'
    ? { type: 'piece', pieceId: winner.id }
    : { type: 'king', player: gainSide };
  const squares = emptyNeighbors(ctx.s, anchorSquare(ctx.s, anchor));
  const info = { defeatedSq, formerSide };
  if (squares.length === 0) {
    // ★ 曖昧な点の仮決め（rules.traitorOnNoSpace）：置けずに山へ還る駒は寝返っていないので【寝返り時】は発動しない
    if (ctx.s.rules.traitorOnNoSpace) fireTrigger(ctx, 'onDefect', loser.id, info);
    returnPiece(ctx, loser.id, 'noSpace');
    return;
  }
  ctx.s = addStat(ctx.s, 'defections');
  ctx.events.push({ type: 'defect', pieceId: loser.id, to: gainSide, from: formerSide, at: defeatedSq });
  fireTrigger(ctx, 'onDefect', loser.id, info);
  if (!ctx.preview) {
    ctx.s = { ...ctx.s, pending: [...ctx.s.pending, { type: 'placeDefector', player: gainSide, pieceId: loser.id, anchor, squares }] };
  }
}

/**
 * 取られた側ドラフト：自分の山の上から2枚を見て、1枚を自分の手札、もう1枚を相手の手札へ。
 * 山が1枚ならその1枚を自分の手札へ（選ぶものがないので保留にしない）。山が空なら何もしない。
 * ★ 山から2枚を「見ている」間は山から抜いて pending に持つ（フィルタで隠す）。
 */
function queueDraft(ctx, pid) {
  if (ctx.preview) return;   // 盤に影響しない
  const deck = ctx.s.players[pid].deck;
  if (deck.length === 0) {
    ctx.events.push({ type: 'draftSkipped', player: pid });
    return;
  }
  ctx.s = addStat(ctx.s, 'drafts');
  if (deck.length === 1) {
    ctx.s = setPlayer(ctx.s, pid, { deck: [], hand: [...ctx.s.players[pid].hand, deck[0]] });
    ctx.events.push({ type: 'draftSingle', player: pid });
    return;
  }
  const n = Math.min(ctx.s.rules.draftSize, deck.length);
  const options = deck.slice(0, n);
  ctx.s = setPlayer(ctx.s, pid, { deck: deck.slice(n) });
  ctx.s = { ...ctx.s, pending: [...ctx.s.pending, { type: 'draft', player: pid, options }] };
  ctx.events.push({ type: 'draftOpen', player: pid });
}

/**
 * 戦闘（from の駒が to の駒を攻める）。解決順は上の 1〜9。
 * 攻撃側が上 → 防御側が倒れ、攻撃側がそのマスに入る。防御側が上 → 攻撃側が倒れ、防御側はそのまま。
 * 同値 → 両方とも元の持ち主の山の底へ（攻撃側 → 防御側の順）。ドラフトは起きない。
 */
function resolveBattle(ctx, from, to, chain) {
  if (ctx.s.result) return;
  const s0 = ctx.s;
  const attacker = pieceAt(s0, from);
  const defender = pieceAt(s0, to);
  const ab = strengthBreakdown(s0, from);
  const db = strengthBreakdown(s0, to);
  const outcome = ab.total > db.total ? 'win' : ab.total < db.total ? 'lose' : 'tie';
  ctx.s = addStat(ctx.s, 'battles');
  if (chain) ctx.s = addStat(ctx.s, 'chainBattles');
  for (const p of [...ab.parts, ...db.parts]) ctx.s = addFire(ctx.s, p.abilityId);
  ctx.events.push({
    type: 'battle', player: ctx.actor, from, to, chain: !!chain,
    attackerId: attacker.id, defenderId: defender.id,
    attackerStrength: ab.total, defenderStrength: db.total,
    attackerBase: ab.base, defenderBase: db.base,
    attackerParts: ab.parts, defenderParts: db.parts, outcome,
  });
  const isKing = (p) => p.kind === ctx.s.kingKind;

  if (outcome === 'tie') {
    ctx.s = addStat(ctx.s, 'ties');
    const aKing = isKing(attacker);
    const dKing = isKing(defender);
    if ((aKing || dKing) && ctx.s.rules.kingTie === 'kingFalls') {
      // ★ 仕様の曖昧な点（キングは山へ還れない）。既定はキングが倒れて決着（CG-021）
      const fallen = [aKing ? attacker : null, dKing ? defender : null].filter(Boolean);
      const by = aKing && dKing ? null : aKing ? defender : attacker;
      ctx.events.push({ type: 'kingFell', tie: true, losers: fallen.map((p) => p.controller), byId: by && by.id, byStrength: ab.total });
      endGame(ctx, { winner: fallen.length === 2 ? null : opponentOf(fallen[0].controller), reason: fallen.length === 2 ? 'bothKings' : 'king' });
      return;
    }
    // kingSurvives: キングはその場に残り、相手の駒だけ山へ。両方キングなら何も起きない
    if (!aKing) {
      ctx.s = setCell(ctx.s, from, null);
      returnPiece(ctx, attacker.id, 'tie');
    }
    if (!dKing) {
      ctx.s = setCell(ctx.s, to, null);
      returnPiece(ctx, defender.id, 'tie');
    }
    return;
  }

  const win = outcome === 'win';
  const winner = win ? attacker : defender;
  const loser = win ? defender : attacker;
  const loserStrength = win ? db.total : ab.total;
  const winnerStrength = win ? ab.total : db.total;
  const defeatedSq = win ? to : from;   // 攻めて負けた駒は、動く前のマスで倒れる
  // 3. 盤の更新
  ctx.s = setCell(ctx.s, from, null);
  ctx.s = setCell(ctx.s, to, winner.id);
  // 4. 勝った側の強さ（フラグ）。★ 減った値は手番をまたいで残る。基礎の強さは0未満にならない
  if (ctx.s.rules.winnerLosesStrength) {
    ctx.s = setPiece(ctx.s, winner.id, { strength: Math.max(0, ctx.s.pieces[winner.id].strength - loserStrength) });
  }
  // 5. キング
  if (isKing(loser)) {
    ctx.events.push({ type: 'kingFell', tie: false, losers: [loser.controller], byId: winner.id, byStrength: winnerStrength });
    endGame(ctx, { winner: opponentOf(loser.controller), reason: 'king' });
    return;
  }
  // 6. 負けた駒：倒された回数を数え、N 回目なら寝返らず元の持ち主の山の底へ
  const defeats = loser.defeats + 1;
  ctx.s = setPiece(ctx.s, loser.id, { defeats });
  // 取られた側＝倒された時点の持ち主（既定）。★ 曖昧な点の仮決め（rules.draftSide）
  const lostSide = ctx.s.rules.draftSide === 'owner' ? loser.owner : loser.controller;
  if (defeats >= ctx.s.rules.defeatsToReturn) {
    returnPiece(ctx, loser.id, 'nth', { defeats });
  } else if (loser.controller === winner.controller) {
    // 押し出しで同じ持ち主の駒どうしが戦った：負けた駒は寝返らず元の持ち主の山へ（仕様）
    returnPiece(ctx, loser.id, 'friendly');
  } else {
    defect(ctx, loser, winner, defeatedSq);
  }
  // 7. 【勝利時】
  fireTrigger(ctx, 'onWin', winner.id);
  // 8. 取られた側ドラフト（寝返り・山へ還る、のどちらでも）
  queueDraft(ctx, lostSide);
  // 9. 【攻めて勝ったとき】（守って勝ったときは発動しない）
  if (win) fireTrigger(ctx, 'onAttackWin', attacker.id, { from, to });
}

/**
 * 押し出し：pusher が from → to へ攻めて勝った。to の攻めた向きのもう1つ先の駒を、その向きに1マス押す。
 *   先が空きマス → そこへ動く ／ 盤の外 → 元の持ち主の山へ（倒されたとして扱い、取られた側ドラフトも起きる）
 *   先に駒 → 押された駒を攻撃側として戦闘。勝って押し出しを持っていればさらに押す（連鎖）
 * 止まる：先に駒がない・不動・キング（rules.kingPushable が false のとき）・
 *         ★ 打ち切り：1回の連鎖の中ですでに動いた駒（攻めた駒自身も「動いた」に数える）
 */
function pushFrom(ctx, ab, pusherId, from, to) {
  if (ctx.s.result) return;
  const a = parseSquare(ctx.s, from);
  const b = parseSquare(ctx.s, to);
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  if (!ctx.chain) {
    ctx.chain = { length: 0, offBoard: 0, battles: 0, stoppedBy: null, origin: to };
    ctx.s = addStat(ctx.s, 'pushChains');
  }
  const stop = (why, at) => {
    ctx.chain.stoppedBy = why;
    ctx.events.push({ type: 'pushStop', why, at: at || null, pusherId });
  };
  // 向きが定まらない攻め（ナイトの跳び）では押せない。★ 今の駒構成ではナイトに押し出しは付いていない
  if (!(dx === 0 || dy === 0 || Math.abs(dx) === Math.abs(dy))) { stop('noDirection'); return; }
  const ux = Math.sign(dx);
  const uy = Math.sign(dy);
  if (!inBoard(ctx.s, b.x + ux, b.y + uy)) { stop('edge'); return; }
  const sq1 = squareName(ctx.s, b.x + ux, b.y + uy);
  const target = pieceAt(ctx.s, sq1);
  if (!target) { stop('empty', sq1); return; }
  if (blocksPush(ctx.s, target)) {
    ctx.s = addFire(ctx.s, abilityOf(ctx.s, target).id);
    stop('blocked', sq1);   // 押されない駒（不動）
    return;
  }
  if (target.kind === ctx.s.kingKind && !ctx.s.rules.kingPushable) { stop('king', sq1); return; }
  if (ctx.moved.has(target.id)) { stop('alreadyMoved', sq1); return; }
  ctx.moved.add(target.id);
  ctx.chain.length++;
  ctx.s = addStat(ctx.s, 'pushedPieces');
  const x2 = b.x + 2 * ux;
  const y2 = b.y + 2 * uy;
  if (!inBoard(ctx.s, x2, y2)) {
    // 盤の外：倒されたとして扱い、元の持ち主の山へ（取られた側ドラフトも起きる）
    ctx.s = setCell(ctx.s, sq1, null);
    ctx.chain.offBoard++;
    ctx.s = addStat(ctx.s, 'pushOffBoard');
    ctx.events.push({ type: 'pushed', pieceId: target.id, from: sq1, to: null, result: 'offBoard', pusherId });
    if (target.kind === ctx.s.kingKind) {
      // キングが押される設定のときだけ起きる。★ キングは山へ還れないので倒れて決着
      ctx.events.push({ type: 'kingFell', tie: false, losers: [target.controller], byId: pusherId, byStrength: null, pushedOff: true });
      endGame(ctx, { winner: opponentOf(target.controller), reason: 'king' });
      return;
    }
    const lostSide = ctx.s.rules.draftSide === 'owner' ? target.owner : target.controller;
    returnPiece(ctx, target.id, 'pushedOff');
    queueDraft(ctx, lostSide);
    stop('offBoard', sq1);
    return;
  }
  const sq2 = squareName(ctx.s, x2, y2);
  if (!pieceAt(ctx.s, sq2)) {
    ctx.s = setCell(setCell(ctx.s, sq1, null), sq2, target.id);
    ctx.events.push({ type: 'pushed', pieceId: target.id, from: sq1, to: sq2, result: 'moved', pusherId });
    stop('moved', sq2);
    return;
  }
  ctx.chain.battles++;
  ctx.chain.stoppedBy = 'battle';   // 押された駒がさらに押し出せば、その段の止まり方で上書きされる
  ctx.events.push({ type: 'pushed', pieceId: target.id, from: sq1, to: sq2, result: 'battle', pusherId });
  resolveBattle(ctx, sq1, sq2, true);
  // 押された駒が勝てば、その駒の【攻めて勝ったとき】が resolveBattle の中で発動する（連鎖）
}

/**
 * 移動・攻撃を解決する。reduce と previewMove の共通の入口。
 * @returns {{ state: object, events: object[], chain: object|null }}
 */
function resolveMove(state, from, to, preview) {
  const ctx = makeCtx(state, preview);
  const attacker = pieceAt(state, from);
  const defender = pieceAt(state, to);
  ctx.s = addStat(ctx.s, 'moves');
  if (!defender) {
    ctx.s = setCell(setCell(ctx.s, from, null), to, attacker.id);
    ctx.events.push({ type: 'move', player: ctx.actor, pieceId: attacker.id, from, to });
  } else {
    ctx.moved.add(attacker.id);
    resolveBattle(ctx, from, to, false);
  }
  if (ctx.chain) ctx.events.push({ type: 'pushChain', ...ctx.chain });
  return { state: { ...ctx.s, lastEvents: ctx.events }, events: ctx.events, chain: ctx.chain };
}

/**
 * 打つ前の結果予測（CG-023）。view と CPU はこれだけを使う。
 * 実際の解決と同じ resolveMove を、山・手札を動かさずに通す（フィルタ済みの state でも動く）。
 * @returns {{ cells: Array, result: object|null, events: object[], chain: object|null }}
 */
function previewMove(state, from, to) {
  const r = resolveMove(state, from, to, true);
  return { cells: r.state.cells, result: r.state.result, events: r.events, chain: r.chain, pieces: r.state.pieces };
}

/**
 * 保留の先頭が寝返りの配置なら、置けるマスをいまの盤で決め直す。
 * 押し出しの連鎖や先に置いた寝返りでマスが埋まり、置き場所が無くなっていたら元の持ち主の山へ還す。
 * ★ モック1（連鎖なし・保留の寝返りは1つだけ）では、寝返った時点と同じマスになる
 */
function settlePending(state) {
  let s = state;
  const extra = [];
  while (!s.result && s.pending.length > 0 && s.pending[0].type === 'placeDefector') {
    const p = s.pending[0];
    const squares = emptyNeighbors(s, anchorSquare(s, p.anchor));
    if (squares.length > 0) {
      if (JSON.stringify(squares) !== JSON.stringify(p.squares)) {
        s = { ...s, pending: [{ ...p, squares }, ...s.pending.slice(1)] };
      }
      break;
    }
    const ctx = makeCtx({ ...s, pending: s.pending.slice(1) }, false);
    returnPiece(ctx, p.pieceId, 'noSpace');
    s = ctx.s;
    extra.push(...ctx.events);
  }
  return extra.length > 0 ? { ...s, lastEvents: [...s.lastEvents, ...extra] } : s;
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
    // 置き場所の起点（anchor）は落とす。置けるマス（squares）だけで足りる
    return { type: p.type, player: p.player, pieceId: p.pieceId, squares: p.squares ? p.squares.slice() : null };
  });
  const pieces = {};
  for (const id of visible) pieces[id] = { ...state.pieces[id] };
  // イベントに出る駒のうち、いま見えない駒（山へ還った駒など）は id を落として種類だけ残す。
  // ★ 種類は盤上で全員が見ていた公開情報。id を残すと山の中身（どの駒がどこにあるか）を辿れる
  //   入れ子（戦闘の内訳 attackerParts の sourceId、能力の changes の pieceId など）も同じように落とす
  const scrub = (v) => {
    if (Array.isArray(v)) return v.map(scrub);
    if (!v || typeof v !== 'object') return v;
    const out = {};
    for (const key of Object.keys(v)) {
      const val = v[key];
      if (/Id$/.test(key) && typeof val === 'string' && state.pieces[val] && !visible.has(val)) {
        out[key.replace(/Id$/, 'Kind')] = state.pieces[val].kind;
      } else {
        out[key] = scrub(val);
      }
    }
    return out;
  };
  const lastEvents = state.lastEvents.map(scrub);
  return {
    version: state.version,
    seed: state.seed,
    kingKind: state.kingKind,
    viewer: playerId,
    rules: { ...state.rules },
    board: state.board,
    defs: state.defs,
    moveTypes: state.moveTypes,
    abilities: state.abilities,
    areas: state.areas,
    cells: state.cells.slice(),
    pieces,
    players,
    active: state.active,
    ply: state.ply,
    pending,
    result: state.result ? { ...state.result } : null,
    stats: { ...state.stats, fires: { ...state.stats.fires } },
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
  pieceSquare,
  abilityOf,
  inArea,
  areaSquares,
  strengthBreakdown,
  effectiveStrength,
  blocksPush,
  battleOutcome,
  kingFallsBy,
  previewMove,
  emptyNeighbors,
  legalActions,
  deckCount,
  handCount,
  actionKey,
  defaultSettings,
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

  // ★ モック1の検査は駒構成をモック1に固定して行う（既定はモック2・CG-023）
  const M1 = { pieceSet: 'mock1' };
  /** 盤を空にして（キングも外して）任意の駒を置いた検査用の state を作る */
  function blank(overrides, opts = {}) {
    let s = createInitialState(opts.seed || 1, cardData, { ...M1, ...overrides });
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
    let s = createInitialState(seed, cardData, { ...M1, ...overrides });
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

  console.log('engine.js セルフテスト（v0.3 モック1・モック2）');

  // --- データ ---
  {
    for (const key of ['mock1', 'mock2']) {
      const total = cardData.pieceSets[key].list.reduce((n, d) => n + d.count, 0);
      check(`データ: ${key} の山は16枚`, total === 16);
    }
    check('データ: 駒構成の既定はモック2', defaultSettings(cardData).pieceSet === 'mock2' && createInitialState(1, cardData).version === cardData.version);
    const defaults = defaultSettings(cardData);
    check('データ: flags の既定値が rules（キングの強さは king.strength）と一致する',
      cardData.flags.list.every((f) => f.key in defaults && f.choices.some((c) => c.value === defaults[f.key])));
    check('データ: キングの強さの既定は data の king.strength', defaults.kingStrength === cardData.king.strength);
    const s0 = createInitialState(1000, cardData, M1);
    check('初期: キングは先手 D7・後手 D1', pieceAt(s0, 'D7').id === 'p1-K' && pieceAt(s0, 'D1').id === 'p2-K');
    check('初期: 盤上はキング2つだけ', boardCount(s0) === 2);
    check('初期: 先手は初期手札3枚＋手番開始の1枚', s0.players.p1.hand.length === 4 && s0.players.p1.deck.length === 12);
    check('初期: 後手は初期手札3枚', s0.players.p2.hand.length === 3 && s0.players.p2.deck.length === 13);
    check('初期: 先手の手番・0手目', s0.active === 'p1' && s0.ply === 0);
  }

  // --- 非破壊性・決定性 ---
  {
    const s0 = deepFreeze(createInitialState(1001, cardData, M1));
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
    let replay = createInitialState(1234, cardData, M1);
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
    const s = createInitialState(1002, cardData, M1);
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

  // --- 曖昧な点の仮決め（firstTurnDraw・draftSide） ---
  {
    const s = createInitialState(1000, cardData, { ...M1, firstTurnDraw: false });
    check('firstTurnDraw=false: 先手は最初の手番に引かない', s.players.p1.hand.length === 3 && s.players.p1.deck.length === 13);
    // 寝返って p1 のものになった p2 のポーンを p2 が倒す
    let d = blank();
    let t = put(d, 'p2', 'pawn', 'G5', 'p1'); d = t.s;
    t = put(d, 'p2', 'rook', 'G3'); d = t.s;
    d = { ...d, active: 'p2' };
    const n1 = reduce(d, { type: 'move', from: 'G3', to: 'G5' });
    check('draftSide=controller（既定）: 倒された時点の持ち主(p1)がドラフト', n1.pending.some((p) => p.type === 'draft' && p.player === 'p1'));
    const d2 = { ...d, rules: { ...d.rules, draftSide: 'owner' } };
    const n2 = reduce(d2, { type: 'move', from: 'G3', to: 'G5' });
    check('draftSide=owner: 元の持ち主(p2)がドラフト', n2.pending.some((p) => p.type === 'draft' && p.player === 'p2'));
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

  // --- キングの強さ（CG-022：デバッグパネルからの上書き） ---
  {
    const s0 = createInitialState(1000, cardData, M1);
    check('キングの強さ: 既定は data の値', s0.pieces['p1-K'].strength === cardData.king.strength && s0.rules.kingStrength === cardData.king.strength);
    const s8 = createInitialState(1000, cardData, { ...M1, kingStrength: 8 });
    check('キングの強さ: 上書きすると両キングとも その値', s8.pieces['p1-K'].strength === 8 && s8.pieces['p2-K'].strength === 8 && s8.defs.king.strength === 8);
    check('キングの強さ: 上書きしても山の並びは変わらない', JSON.stringify(s8.players) === JSON.stringify(s0.players));
    check('キングの強さ: 視点フィルタ後の rules にも出る', filterStateFor(s8, 'p2').rules.kingStrength === 8);
    // 強さ8のキングにクイーン（5）が挑むと負ける。減る設定ならキングは 8 - 5 = 3 になる
    let k = blank({ kingStrength: 8, winnerLosesStrength: true });
    let t = put(k, 'p1', 'queen', 'D3'); k = t.s;
    k = { ...k, active: 'p1' };
    check('キングの強さ8: クイーンは負ける', battleOutcome(k, 'D3', 'D1') === 'lose');
    const kn = reduce(k, { type: 'move', from: 'D3', to: 'D1' });
    check('キングの強さ8・減る設定: キングは 3 に減り、決着しない', !kn.result && kn.pieces['p2-K'].strength === 3);
  }

  // --- 手番・引き方・200手 ---
  {
    const s = createInitialState(1003, cardData, { ...M1, drawMode: 'action' });
    check('引き方(行動): 開始時に引かない', s.players.p1.hand.length === 3);
    check('引き方(行動): 引くことが合法手に入る', legalActions(s, 'p1').some((a) => a.type === 'draw'));
    const n = reduce(s, { type: 'draw' });
    check('引き方(行動): 引くと1手使う', n.ply === 1 && n.active === 'p2' && n.players.p1.hand.length === 4 && n.players.p2.hand.length === 3);
    const d = createInitialState(1003, cardData, M1);
    check('引き方(既定): 引くは合法手に入らない', !legalActions(d, 'p1').some((a) => a.type === 'draw'));
    const end = playout(1004, { maxPlies: 6 });
    check('打ち切り: maxPlies に達したら引き分け', end.state.result.ply <= 6 && (end.state.result.reason !== 'maxPlies' || end.state.result.winner === null));
    const long = createInitialState(1004, cardData, { ...M1, maxPlies: 2 });
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
      let s = createInitialState(seed, cardData, M1);
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
      let s = createInitialState(seed, cardData, M1);
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

  // =========================================================================
  // モック2（CG-023）：実際の強さと能力8種
  // =========================================================================
  const M2 = { pieceSet: 'mock2' };
  const blank2 = (overrides, opts) => blank({ ...M2, ...overrides }, opts);
  const eff = (s, sq) => effectiveStrength(s, sq);
  /** 予測（previewMove）と実際の解決（reduce）の盤・決着が一致するか */
  const sameAsPreview = (s, from, to) => {
    const pv = previewMove(filterStateFor(s, s.active), from, to);
    const n = reduce(s, { type: 'move', from, to });
    return JSON.stringify(pv.cells) === JSON.stringify(n.cells) && JSON.stringify(pv.result && { ...pv.result }) === JSON.stringify(n.result && { ...n.result });
  };

  // --- 実際の強さ（常時の効果） ---
  {
    let s = blank2();
    let t = put(s, 'p1', 'queenInspire', 'D4'); s = t.s;
    for (const sq of ['C3', 'E4', 'B4']) { t = put(s, 'p1', 'pawn', sq); s = t.s; }
    t = put(s, 'p2', 'pawn', 'D3'); s = t.s;
    check('鼓舞: 周囲8マスの味方+1（斜め C3・縦横 E4）', eff(s, 'C3') === 2 && eff(s, 'E4') === 2);
    check('鼓舞: 範囲外の味方（B4）・敵（D3）・自分（D4）は変わらない', eff(s, 'B4') === 1 && eff(s, 'D3') === 1 && eff(s, 'D4') === 4);
    const bd = strengthBreakdown(s, 'C3');
    check('内訳: 基礎1＋鼓舞(D4)+1', bd.base === 1 && bd.parts.length === 1 && bd.parts[0].abilityId === 'inspire' && bd.parts[0].from === 'D4' && bd.parts[0].amount === 1);

    s = blank2();
    t = put(s, 'p1', 'knightPhalanx', 'D4'); s = t.s;
    t = put(s, 'p1', 'pawn', 'D3'); s = t.s;
    t = put(s, 'p1', 'pawn', 'C3'); s = t.s;
    t = put(s, 'p2', 'pawn', 'E4'); s = t.s;
    check('槍衾: 縦横1マスの味方+2', eff(s, 'D3') === 3);
    check('槍衾: 斜めの味方・縦横の敵・自分には効かない', eff(s, 'C3') === 1 && eff(s, 'E4') === 1 && eff(s, 'D4') === 2);

    s = blank2();
    t = put(s, 'p2', 'bishopIntimidate', 'D4'); s = t.s;
    t = put(s, 'p2', 'bishopIntimidate', 'D2'); s = t.s;
    t = put(s, 'p1', 'pawn', 'C3'); s = t.s;
    t = put(s, 'p1', 'knightPhalanx', 'B5'); s = t.s;
    t = put(s, 'p2', 'pawn', 'E4'); s = t.s;
    check('威圧: 周囲8マスの敵-1（2つ重なると-2）。実際の強さは0未満にならない', eff(s, 'C3') === 0 && strengthBreakdown(s, 'C3').parts.length === 2);
    check('威圧: 味方（E4）・範囲外の敵（B5）には効かない', eff(s, 'E4') === 1 && eff(s, 'B5') === 2);

    s = blank2();
    t = put(s, 'p1', 'pawn', 'D4'); s = t.s;
    t = put(s, 'p1', 'queenInspire', 'C4'); s = t.s;
    t = put(s, 'p1', 'knightPhalanx', 'D5'); s = t.s;
    t = put(s, 'p2', 'bishopIntimidate', 'E3'); s = t.s;
    check('重ねがけ: 1＋鼓舞1＋槍衾2−威圧1＝3（すべて足し合わせる）', eff(s, 'D4') === 3 && strengthBreakdown(s, 'D4').parts.length === 3);
    t = put(s, 'p2', 'queenInspire', 'D6', 'p1');
    check('キングも効果を受ける（D7 のキングに D6 の鼓舞で +1）', eff(t.s, 'D7') === cardData.king.strength + 1);
  }

  // --- 戦闘は実際の強さで比べる（攻撃側は動く前のマス） ---
  {
    let s = blank2();
    let t = put(s, 'p1', 'queenInspire', 'B6'); s = t.s;
    t = put(s, 'p1', 'pawn', 'C5'); s = t.s;
    t = put(s, 'p2', 'pawn', 'D4'); s = t.s;
    s = { ...s, active: 'p1' };
    check('戦闘: 攻撃側は動く前のマスで鼓舞を受ける（C5 で 2 対 1）', battleOutcome(s, 'C5', 'D4') === 'win');
    const n = reduce(s, { type: 'move', from: 'C5', to: 'D4' });
    check('戦闘: 実際の強さで勝ち、D4 に入る', pieceAt(n, 'D4').owner === 'p1' && n.lastEvents[0].attackerStrength === 2 && n.lastEvents[0].defenderStrength === 1);
    t = put(s, 'p2', 'knightPhalanx', 'D3'); const s2 = t.s;
    check('戦闘: 防御側は槍衾で 3 になり、攻撃側が負ける', battleOutcome(s2, 'C5', 'D4') === 'lose');
    // 勝った側が減る：負けた駒の実際の強さぶん減る
    let w = blank2({ winnerLosesStrength: true });
    t = put(w, 'p1', 'rookImmovable', 'A5'); w = t.s; const rk = t.id;
    t = put(w, 'p2', 'pawn', 'A3'); w = t.s;
    t = put(w, 'p2', 'knightPhalanx', 'B3'); w = t.s;
    w = { ...w, active: 'p1' };
    const wn = reduce(w, { type: 'move', from: 'A5', to: 'A3' });
    check('減る設定: 勝った駒の基礎が、負けた駒の実際の強さ（1＋槍衾2＝3）ぶん減る（4−3＝1）', wn.pieces[rk].strength === 1);
  }

  // --- 凱歌 ---
  {
    let s = blank2();
    let t = put(s, 'p1', 'pawnTriumph', 'C5'); s = t.s; const tri = t.id;
    s = setPiece(s, tri, { strength: 2 });
    t = put(s, 'p2', 'pawn', 'D4'); s = t.s;
    s = { ...s, active: 'p1' };
    let n = reduce(s, { type: 'move', from: 'C5', to: 'D4' });
    check('凱歌: 攻めて勝つと基礎+1（2 → 3）', n.pieces[tri].strength === 3 && n.stats.fires.triumph === 1);
    s = blank2();
    t = put(s, 'p1', 'pawnTriumph', 'C5'); s = t.s; const tri2 = t.id;
    s = setPiece(s, tri2, { strength: 2 });
    t = put(s, 'p2', 'pawn', 'B4'); s = t.s;
    s = { ...s, active: 'p2' };
    n = reduce(s, { type: 'move', from: 'B4', to: 'C5' });
    check('凱歌: 守って勝っても基礎+1（2 → 3）', n.pieces[tri2].strength === 3 && pieceAt(n, 'C5').id === tri2);
    // 寝返ると初期値に戻る
    let r = blank2();
    t = put(r, 'p1', 'pawnTriumph', 'C5'); r = t.s; const tri3 = t.id;
    r = setPiece(r, tri3, { strength: 3 });
    t = put(r, 'p2', 'rookImmovable', 'C3'); r = t.s;
    r = { ...r, active: 'p2' };
    n = reduce(r, { type: 'move', from: 'C3', to: 'C5' });
    check('凱歌: 寝返った駒の基礎の強さは初期値に戻る（3 → 1）', n.pieces[tri3].controller === 'p2' && n.pieces[tri3].strength === 1);
  }

  // --- 裏切り者 ---
  {
    const setup = (o) => {
      let s = blank2(o);
      let t = put(s, 'p2', 'knightTraitor', 'D4'); s = t.s; const tr = t.id;
      t = put(s, 'p2', 'pawn', 'C4'); s = t.s; const near1 = t.id;
      t = put(s, 'p2', 'pawn', 'E5'); s = t.s; const near2 = t.id;
      t = put(s, 'p2', 'pawn', 'A4'); s = t.s; const far = t.id;
      t = put(s, 'p1', 'queenInspire', 'D6'); s = t.s;
      return { s: { ...s, active: 'p1' }, tr, near1, near2, far };
    };
    let x = setup();
    let n = reduce(x.s, { type: 'move', from: 'D6', to: 'D4' });
    check('裏切り者: 寝返った瞬間、倒されたマス（D4）の周囲8マスの元の味方の基礎-1', n.pieces[x.near1].strength === 0 && n.pieces[x.near2].strength === 0);
    check('裏切り者: 範囲外の元の味方は変わらない・発動は1回', n.pieces[x.far].strength === 1 && n.stats.fires.traitor === 1);
    check('裏切り者: 置き場所（キングの周囲）に関わらず倒れたマスで発動する', n.pending[0].type === 'placeDefector' && !n.pending[0].squares.some((q) => ['C4', 'E5'].includes(q)));
    x = setup();
    const nth = reduce(setPiece(x.s, x.tr, { defeats: 1 }), { type: 'move', from: 'D6', to: 'D4' });
    check('裏切り者: N 回目に倒されて山へ還るときは発動しない', nth.pieces[x.near1].strength === 1 && nth.stats.fires.traitor === 0);
    // 攻めて負けた裏切り者は動く前のマスで倒れる
    let a = blank2();
    let t = put(a, 'p1', 'knightTraitor', 'C5'); a = t.s;
    t = put(a, 'p1', 'pawn', 'C6'); a = t.s; const ally = t.id;
    t = put(a, 'p2', 'rookImmovable', 'D3'); a = t.s;
    a = { ...a, active: 'p1' };
    n = reduce(a, { type: 'move', from: 'C5', to: 'D3' });
    check('裏切り者: 攻めて負けたら、動く前のマス（C5）の周囲の元の味方-1', n.pieces[ally].strength === 0 && n.stats.fires.traitor === 1);
    // 置き場所がなく山へ還るとき（既定：発動しない／フラグで発動する）
    const nospace = (o) => {
      let s = blank2(o, { k1: 'A7' });
      for (const sq of ['A6', 'B6', 'B7']) { const u = put(s, 'p1', 'pawn', sq); s = u.s; }
      let u = put(s, 'p1', 'rookImmovable', 'G5'); s = u.s;
      u = put(s, 'p2', 'knightTraitor', 'G3'); s = u.s;
      u = put(s, 'p2', 'pawn', 'F3'); s = u.s; const nb = u.id;
      return { n: reduce({ ...s, active: 'p1' }, { type: 'move', from: 'G5', to: 'G3' }), nb };
    };
    const ns1 = nospace();
    check('裏切り者: 置き場所がなく山へ還るときは発動しない（既定 traitorOnNoSpace=false）', ns1.n.stats.returnsNoSpace === 1 && ns1.n.pieces[ns1.nb].strength === 1);
    const ns2 = nospace({ traitorOnNoSpace: true });
    check('裏切り者: traitorOnNoSpace=true なら発動する', ns2.n.pieces[ns2.nb].strength === 0);
  }

  // --- 遺言 ---
  {
    const lw = (o, deck) => {
      let s = blank2(o);
      let t = put(s, 'p2', 'pawnLastWill', 'G3'); s = t.s; const id = t.id;
      s = setPiece(s, id, { defeats: 1 });
      t = put(s, 'p1', 'rookImmovable', 'G5'); s = t.s;
      if (deck) s = setPlayer(s, 'p2', { deck: deck(s.players.p2.deck) });
      return { s: { ...s, active: 'p1' }, id };
    };
    let x = lw();
    const top = x.s.players.p2.deck[0];
    const h = x.s.players.p2.hand.length;
    let n = reduce(x.s, { type: 'move', from: 'G5', to: 'G3' });
    check('遺言: 山へ還るとき元の持ち主（p2）が山から1枚引く', n.players.p2.hand.includes(top) && n.players.p2.hand.length === h + 1 && n.stats.fires.lastWill === 1);
    // 山が空のとき（同値で両方山へ還る形で確かめる。取られた側ドラフトが起きず、引き方を「1行動」にして
    // 手番の開始時にも引かないので、手札の変化は遺言だけになる）
    const tieEmpty = (o) => {
      let u = blank2({ drawMode: 'action', ...o });
      let v = put(u, 'p2', 'pawnLastWill', 'D4'); u = v.s; const id = v.id;
      v = put(u, 'p1', 'pawn', 'C5'); u = v.s;
      u = setPlayer(u, 'p2', { deck: [] });
      return { n: reduce({ ...u, active: 'p1' }, { type: 'move', from: 'C5', to: 'D4' }), id };
    };
    let e = tieEmpty();
    check('遺言: 山が空なら、底へ入れた後に引くのでその駒自身を引く（既定 onReturnTiming=afterReturn）', e.n.players.p2.hand.includes(e.id) && !e.n.players.p2.deck.includes(e.id));
    e = tieEmpty({ onReturnTiming: 'beforeReturn' });
    check('遺言: onReturnTiming=beforeReturn なら先に引く（山が空なら何も引かず、駒は山へ）', !e.n.players.p2.hand.includes(e.id) && e.n.players.p2.deck.includes(e.id) && e.n.stats.fires.lastWill === 1);
    // 同値で山へ還るときも発動する
    let tie = blank2();
    let t = put(tie, 'p2', 'pawnLastWill', 'D4'); tie = t.s;
    t = put(tie, 'p1', 'pawn', 'C5'); tie = t.s;
    n = reduce({ ...tie, active: 'p1' }, { type: 'move', from: 'C5', to: 'D4' });
    check('遺言: 同値で山へ還るときも発動する', n.stats.returnsTie === 2 && n.stats.fires.lastWill === 1);
  }

  // --- 押し出し ---
  {
    const base = (o) => {
      let s = blank2(o);
      const t = put(s, 'p1', 'rookPush', 'D6'); s = t.s;
      return { s, rook: t.id };
    };
    // 空きマスへ
    let b = base();
    let t = put(b.s, 'p2', 'pawn', 'D4'); let s = t.s;
    t = put(s, 'p2', 'pawn', 'D3'); s = t.s; const pushed = t.id;
    s = { ...s, active: 'p1' };
    check('押し出し(予測): 予測と実際の解決が一致する（空きマス）', sameAsPreview(s, 'D6', 'D4'));
    let n = reduce(s, { type: 'move', from: 'D6', to: 'D4' });
    check('押し出し: 攻めて勝つと、倒した駒のマスの1つ先（D3）の駒を攻めた向きに1マス押す（D2 へ）', pieceAt(n, 'D4').id === b.rook && !pieceAt(n, 'D3') && pieceAt(n, 'D2').id === pushed);
    check('押し出し: 連鎖の長さ1・発動1回', n.stats.fires.push === 1 && n.stats.pushedPieces === 1 && n.lastEvents.some((e) => e.type === 'pushChain' && e.length === 1 && e.stoppedBy === 'moved'));
    // 敵味方を問わない
    b = base();
    t = put(b.s, 'p2', 'pawn', 'D4'); s = t.s;
    t = put(s, 'p1', 'pawn', 'D3'); s = t.s; const own = t.id;
    n = reduce({ ...s, active: 'p1' }, { type: 'move', from: 'D6', to: 'D4' });
    check('押し出し: 味方の駒も押す', pieceAt(n, 'D2').id === own);
    // 盤の外へ
    let o = blank2();
    t = put(o, 'p1', 'rookPush', 'A4'); o = t.s;
    t = put(o, 'p2', 'pawn', 'A2'); o = t.s;
    t = put(o, 'p2', 'pawnTriumph', 'A1'); o = t.s; const off = t.id;
    o = { ...o, active: 'p1' };
    check('押し出し(予測): 予測と実際の解決が一致する（盤外）', sameAsPreview(o, 'A4', 'A2'));
    n = reduce(o, { type: 'move', from: 'A4', to: 'A2' });
    check('押し出し: 盤の外へ押された駒は元の持ち主の山へ還る', !pieceAt(n, 'A1') && n.players.p2.deck.includes(off) && n.stats.pushOffBoard === 1 && n.stats.returnsPushedOff === 1);
    check('押し出し: 盤外は倒されたとして扱い、取られた側ドラフトも起きる（寝返りの分と合わせて2回）', n.stats.drafts === 2);
    // 味方同士の衝突（押された p2 のビショップ 2 が p2 のポーン 1 とぶつかる）
    b = base();
    t = put(b.s, 'p2', 'pawn', 'D4'); s = t.s;
    t = put(s, 'p2', 'bishopIntimidate', 'D3'); s = t.s; const bis = t.id;
    t = put(s, 'p2', 'pawn', 'D2'); s = t.s; const friend = t.id;
    s = { ...s, active: 'p1' };
    check('押し出し(予測): 予測と実際の解決が一致する（味方同士の衝突）', sameAsPreview(s, 'D6', 'D4'));
    n = reduce(s, { type: 'move', from: 'D6', to: 'D4' });
    check('押し出し: 押された駒を攻撃側として戦闘する（ビショップが D2 に入る）', pieceAt(n, 'D2').id === bis && n.stats.chainBattles === 1);
    check('押し出し: 同じ持ち主の駒同士の戦闘で負けた駒は寝返らず元の持ち主の山へ', n.players.p2.deck.includes(friend) && n.pieces[friend].controller === 'p2' && n.stats.returnsFriendly === 1 && n.pending.filter((p) => p.type === 'placeDefector').length === 1);
    // 不動で止まる
    b = base();
    t = put(b.s, 'p2', 'pawn', 'D4'); s = t.s;
    t = put(s, 'p2', 'rookImmovable', 'D3'); s = t.s; const imm = t.id;
    n = reduce({ ...s, active: 'p1' }, { type: 'move', from: 'D6', to: 'D4' });
    check('不動: 押し出しで押されない（D3 のまま・何も起こさず止まる）', pieceAt(n, 'D3').id === imm && !pieceAt(n, 'D2') && n.stats.fires.immovable === 1 && n.stats.pushedPieces === 0);
    // キングで止まる（既定）／押される（フラグ）
    b = base();
    t = put(b.s, 'p2', 'pawn', 'D4'); s = t.s;
    s = setCell(setCell(s, 'D1', null), 'D3', 'p2-K');
    n = reduce({ ...s, active: 'p1' }, { type: 'move', from: 'D6', to: 'D4' });
    check('押し出し: キングは押されない（既定）', pieceAt(n, 'D3').id === 'p2-K' && n.lastEvents.some((e) => e.type === 'pushStop' && e.why === 'king'));
    const kp = { ...s, rules: { ...s.rules, kingPushable: true }, active: 'p1' };
    n = reduce(kp, { type: 'move', from: 'D6', to: 'D4' });
    check('押し出し: kingPushable=true ならキングも押される', pieceAt(n, 'D2').id === 'p2-K' && !n.result);
    let ko = blank2({ kingPushable: true });
    t = put(ko, 'p1', 'rookPush', 'D4'); ko = t.s;
    t = put(ko, 'p2', 'pawn', 'D2'); ko = t.s;
    ko = { ...ko, active: 'p1' };
    check('押し出し(予測): 予測と実際の解決が一致する（キングを盤外へ）', sameAsPreview(ko, 'D4', 'D2') && kingFallsBy(ko, 'D4', 'D2') === 'p2');
    n = reduce(ko, { type: 'move', from: 'D4', to: 'D2' });
    check('押し出し: kingPushable=true でキングが盤外へ押されたら倒れて決着', n.result && n.result.winner === 'p1');
    // 連鎖：押されたルーク（押し出し持ち）が勝ち、さらに押す
    let c = blank2();
    t = put(c, 'p1', 'rookPush', 'C6'); c = t.s;
    t = put(c, 'p2', 'pawn', 'C4'); c = t.s;
    t = put(c, 'p2', 'rookPush', 'C3'); c = t.s; const r2 = t.id;
    t = put(c, 'p1', 'pawn', 'C2'); c = t.s;
    t = put(c, 'p2', 'pawn', 'C1'); c = t.s; const last = t.id;
    c = { ...c, active: 'p1' };
    const pvc = previewMove(filterStateFor(c, 'p1'), 'C6', 'C4');
    check('連鎖(予測): 予測と実際の解決が一致する', sameAsPreview(c, 'C6', 'C4'));
    n = reduce(c, { type: 'move', from: 'C6', to: 'C4' });
    check('連鎖: 押されたルークが C2 の駒に勝って入り、さらに C1 の駒を盤外へ押す', pieceAt(n, 'C2').id === r2 && !pieceAt(n, 'C3') && !pieceAt(n, 'C1') && n.players.p2.deck.includes(last));
    check('連鎖: 長さ2・戦闘1・盤外1（予測にも同じ連鎖が出る）', pvc.chain.length === 2 && pvc.chain.battles === 1 && pvc.chain.offBoard === 1 && n.stats.fires.push === 2);
    check('連鎖: 保留は起きた順（寝返り→ドラフト→寝返り→ドラフト→ドラフト）',
      JSON.stringify(n.pending.map((p) => `${p.type}:${p.player}`)) === JSON.stringify(['placeDefector:p1', 'draft:p2', 'placeDefector:p2', 'draft:p1', 'draft:p2']));
    // 保留を全部解決できる（置けるマスは解決する時点の盤で決め直す）
    let m = n;
    let guard = 0;
    while (m.pending.length > 0 && guard++ < 10) m = reduce(m, legalActions(m, decider(m))[0]);
    check('連鎖: 保留を順に解決すると相手の手番になる', m.pending.length === 0 && m.active === 'p2' && totalPieces(m) === 34);
    // 打ち切り：1回の連鎖の中で同じ駒が動くのは1度まで（直線の連鎖では起きないので、動いた印を付けて確かめる）
    b = base();
    t = put(b.s, 'p2', 'pawn', 'D4'); s = t.s;
    t = put(s, 'p2', 'pawn', 'D3'); s = t.s; const mv = t.id;
    s = setCell(setCell(s, 'D6', null), 'D4', b.rook);
    const ctx = makeCtx(s, false);
    ctx.moved.add(mv);
    pushFrom(ctx, s.abilities.push, b.rook, 'D6', 'D4');
    check('打ち切り: すでに動いた駒に当たったら連鎖はそこで止まる（何も動かない）', pieceAt(ctx.s, 'D3').id === mv && ctx.chain.stoppedBy === 'alreadyMoved' && ctx.chain.length === 0);
    // 守って勝ったときは発動しない
    let d = blank2();
    t = put(d, 'p1', 'rookPush', 'D4'); d = t.s;
    t = put(d, 'p2', 'pawn', 'C3'); d = t.s;
    t = put(d, 'p2', 'pawn', 'E5'); d = t.s; const behind = t.id;
    n = reduce({ ...d, active: 'p2' }, { type: 'move', from: 'C3', to: 'D4' });
    check('押し出し: 守って勝ったときは発動しない', pieceAt(n, 'E5').id === behind && n.stats.fires.push === 0 && n.stats.pushChains === 0);
    // ナイトの跳び（向きが定まらない）では押さない
    let kn = blank2();
    t = put(kn, 'p2', 'rookPush', 'D4', 'p1'); kn = t.s;   // 押し出しの駒を寝返らせてナイトと同じ扱いはできないので、内部関数で向きだけ確かめる
    const kc = makeCtx(kn, true);
    pushFrom(kc, kn.abilities.push, pieceAt(kn, 'D4').id, 'C6', 'D4');
    check('押し出し: 向きが定まらない攻め（ナイトの跳び C6→D4）では押さない', kc.chain.stoppedBy === 'noDirection');
  }

  // --- 自動対戦：予測と実際の解決の一致・不変条件・視点フィルタ（モック2） ---
  {
    let mismatch = 0;
    let compared = 0;
    let chains = 0;
    let offBoard = 0;
    let total = true;
    let nonNeg = true;
    let leaked = false;
    let legalSame = true;
    const fired = {};
    for (const o of [{}, { winnerLosesStrength: true }, { winnerLosesStrength: true, defectorPlacement: 'winner', kingPushable: true }]) {
      for (let seed = 2100; seed < 2140; seed++) {
        let s = createInitialState(seed, cardData, { ...M2, ...o });
        let r = createRng(seed);
        while (!s.result) {
          const who = decider(s);
          const acts = legalActions(s, who);
          // 攻撃を優先して選ぶ（押し出しを起こしやすくする）。それ以外はランダム
          const d = nextRandom(r); r = d.rng;
          const attacks = acts.filter((a) => a.type === 'move' && pieceAt(s, a.to));
          const a = attacks.length > 0 && d.value < 0.6 ? attacks[Math.floor(d.value / 0.6 * attacks.length)] : acts[Math.floor(d.value * acts.length)];
          const v = filterStateFor(s, who);
          if (decider(s) === who && s.pending.length === 0) {
            const a1 = legalActions(s, who).map(actionKey).join(',');
            if (a1 !== legalActions(v, who).map(actionKey).join(',')) legalSame = false;
          }
          for (const viewer of PLAYERS) {
            const fv = filterStateFor(s, viewer);
            const json = JSON.stringify(fv);
            const opp = opponentOf(viewer);
            for (const id of s.players[opp].hand) if (json.includes(`"${id}"`)) leaked = true;
            for (const pid of PLAYERS) for (const id of s.players[pid].deck) if (json.includes(`"${id}"`)) leaked = true;
            for (const p of s.pending) if (p.type === 'draft' && p.player !== viewer) for (const id of p.options) if (json.includes(`"${id}"`)) leaked = true;
          }
          let pv = null;
          if (a.type === 'move') pv = previewMove(v, a.from, a.to);
          s = reduce(s, a);
          if (pv) {
            compared++;
            // 200手の打ち切りは移動の解決の後に手数で起きるもので、移動の結果ではないので比べない
            const moveResult = s.result && s.result.reason !== 'maxPlies' ? s.result : null;
            if (JSON.stringify(pv.cells) !== JSON.stringify(s.cells) || JSON.stringify(pv.result) !== JSON.stringify(moveResult)) mismatch++;
            if (pv.chain) { chains++; offBoard += pv.chain.offBoard; }
          }
          if (!s.result && totalPieces(s) !== 34) total = false;
          for (const id of s.cells) if (id && (s.pieces[id].strength < 0 || effectiveStrength(s, pieceSquare(s, id)) < 0)) nonNeg = false;
        }
        for (const k of Object.keys(s.stats.fires)) fired[k] = (fired[k] || 0) + s.stats.fires[k];
      }
    }
    console.log(`  （参考）モック2 120局：予測と比べた移動 ${compared} 回・押し出しの連鎖 ${chains} 回・盤外 ${offBoard} 回・発動 ${JSON.stringify(fired)}`);
    check('予測: 自動対戦の全ての移動で、予測（フィルタ済みの state）と実際の解決の盤・決着が一致する', compared > 0 && mismatch === 0);
    check('予測: 自動対戦で押し出しの連鎖と盤外への押し出しが実際に起きている（検査が空振りしていない）', chains > 0 && offBoard > 0);
    check('能力: 自動対戦で8種すべてが1回以上発動している', Object.keys(cardData.abilities).filter((k) => k[0] !== '_').every((k) => fired[k] > 0));
    check('不変条件(モック2): 駒の総数は常に34', total);
    check('不変条件(モック2): 基礎の強さ・実際の強さは0未満にならない', nonNeg);
    check('フィルタ(モック2): 相手の手札・両者の山・相手のドラフトの2枚が含まれない（イベントの入れ子も）', !leaked);
    check('フィルタ(モック2): フィルタ後の state でも本人の合法手は同じ', legalSame);
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
    const abilityIds = Object.keys(cardData.abilities).filter((k) => k[0] !== '_');
    check('engine.js: 能力の id（鼓舞・押し出し…）で分岐していない（発火点と効果の型だけを知っている）', abilityIds.every((id) => !eng.includes(`'${id}'`) && !eng.includes(`"${id}"`)));
  }

  console.log(failures === 0 ? `\n${checks} 件すべて成功` : `\n${checks} 件中 ${failures} 件失敗`);
  if (failures > 0) process.exit(1);
}

})(typeof globalThis !== 'undefined' ? globalThis : this);

/**
 * engine.js — 純粋なゲームロジック（v0.3 モック1・CG-021 ＋ モック2・CG-023 ＋ モック3・CG-024）
 *
 * 【不可逆制約】詳細は CLAUDE.md
 *   - DOM / window / document に一切触らない。Node 単体で実行できること
 *   - (state, action) => newState の純粋関数。既存 state を破壊的に変更しない
 *   - action は JSON 化可能なオブジェクトのみ
 *   - filterStateFor(state, playerId) で相手の手札と両者の山の中身を落とす
 *   - 乱数は下記 seeded RNG のみ。Math.random() 禁止
 *   - 駒の数値・動き・ルールフラグは data/cards.js。ここにベタ書きしない
 *
 * 【仕様の正本】Notion CURRENT_SPEC「v0.3 モック1 仕様」「v0.3 モック2 追加仕様」「v0.3 モック3 追加仕様」
 *   7×7・キングだけの空の盤から育てる・1手番1行動・強さ1値の戦闘・寝返り・
 *   N 回目に倒されたら元の持ち主の山へ・取られた側ドラフト。
 *   モック2：実際の強さ（基礎＋常時の効果）と能力8種。能力の中身は data の abilities にあり、
 *   engine は発火点と効果の型（EFFECTS 表）だけを知っている。打つ前の結果予測（previewMove）は
 *   実際の解決と同じ resolveMove を通る。
 *   モック3：能力2種（運ぶ＝攻撃でない移動の発火点 onMove／投げる＝手番の行動 action）と前線基地。
 *   投げるの予測（previewThrow）も実際の解決と同じ resolveThrow を通る。前線基地は毎回盤から計算する。
 *   モック4（CG-025）：発火点「動かされたとき onMoved」「押されたとき onPushed」「投げられて着地したとき onLanded」
 *   「自分で動いたとき onSelfMove（攻撃で勝って入ったときも）」を足した。能力で駒が動くと必ず afterDisplaced を通り、
 *   そこで発火点を順に発動する（深さ優先）。何段目の動きかを ctx.depthOf で数え、イベントに depth を付ける。
 *   入れ替え（手番の行動 swap）の予測も実際の解決と同じ resolveSwap を通る。
 *
 * 【読み込み形式】CG-008 を踏襲
 *   全体を即時関数で包み、ブラウザ＝グローバル NECRO_ENGINE、Node＝module.exports。
 *   この外側の包みを外さないこと。
 *
 * 【action】
 *   { type: 'move',  from: 'D7', to: 'D6' }          盤上の自分の駒を動かす（攻撃を含む）
 *   { type: 'place', pieceId: 'p1-03', to: 'C7' }    手札から1枚置く
 *   { type: 'move',  from: 'D7', to: 'D6', carry: 'E7' }  運ぶ（改）の駒の移動は、一緒に動かす隣の味方のマスを carry に入れる
 *                                                    （null＝運ばない。候補がない移動には carry を付けない。CG-025）
 *   { type: 'throw', from: 'C5', to: 'F2' }          投げる（from＝投げられる駒のマス、to＝着地点。投げる駒は間のマス）
 *   { type: 'swap',  from: 'C7', to: 'D6' }          入れ替え（from＝入れ替える駒のマス、to＝隣の味方のマス。CG-025）
 *   { type: 'draw' }                                 引く（rules.drawMode = 'action' のときだけ）
 *   { type: 'pass' }                                 合法手が1つもないときだけ
 *   { type: 'placeDefector', to: 'E6' }              寝返った駒を置く（手番を使わない）
 *   { type: 'draftPick', keep: 0 }                   ドラフト：options[keep] を自分の手札、残りを相手へ
 *   上の6つが「手」（ply を1進める）。下の2つは保留中の決定で、手を進めない。
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
  // すり抜け（CG-025・常時の効果 passAllies）：直線に動く駒（slide）は、味方を count 体まで飛び越えられる。敵は飛び越えない
  const passN = mt.slide && !mt.jump ? alliesPassable(state, piece) : 0;
  const consider = (dx, dy, mode) => {
    // mode: 'both' | 'moveOnly' | 'captureOnly'
    let x = from.x;
    let y = from.y;
    let passed = 0;
    for (;;) {
      x += dx;
      y += dy * fwd;
      if (!inBoard(state, x, y)) return;
      const target = pieceAt(state, squareName(state, x, y));
      if (target && target.controller === piece.controller && passed < passN) {
        passed++;   // 味方を飛び越える（そのマスには止まれない）
        continue;
      }
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

/** 手札の駒の普段の置き場所（自陣の奥の列から range 列ぶん・空きマスのみ） */
function basicPlacementSquares(state, playerId, pieceId) {
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

/**
 * 前線基地（CG-024）：今の持ち主が playerId の moveType（ポーン）の駒が相手側の最奥列にいる間、
 * その area の範囲の空きマスが playerId の置き場所に加わる。どの駒も使える。
 * ★ 状態として持たず、毎回盤から計算する（そのポーンが倒される・動く・寝返ると、その場で消える）。
 * @returns {string[]} 盤の順（行1→7、列A→G）。普段の置き場所と重なるマスも含む
 */
function frontBaseSquares(state, playerId) {
  const fb = state.frontBase;
  if (!fb || !state.rules.frontBase) return [];
  const row = state.board.homeRow[opponentOf(playerId)];
  const set = new Set();
  for (let x = 0; x < state.board.cols; x++) {
    const sq = squareName(state, x, row);
    const pc = pieceAt(state, sq);
    if (!pc || pc.controller !== playerId || defOf(state, pc).move !== fb.moveType) continue;
    for (const t of areaSquares(state, fb.area, sq)) if (!pieceAt(state, t)) set.add(t);
  }
  return allSquares(state).filter((sq) => set.has(sq));
}

/** 手札の駒を置けるマス：普段の置き場所 ＋ 前線基地で加わるマス（普段の置き場所の後ろに盤の順で足す） */
function placementSquares(state, playerId, pieceId) {
  const basic = basicPlacementSquares(state, playerId, pieceId);
  if (!state.pieces[pieceId]) return basic;
  const extra = frontBaseSquares(state, playerId).filter((sq) => !basic.includes(sq));
  return extra.length > 0 ? [...basic, ...extra] : basic;
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
  immovable: { blocksPush: true, blocksThrow: true },
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
  // 運ぶ（CG-024）：発火点 onMove（手番の行動で、攻撃でない移動をしたとき）。
  //   side の隣（info.from から見て）にいる味方の駒（キングを除く）が、同じ向きに同じだけ動く。
  //   行き先が空きマスでない（駒がいる・盤の外）ときは動かない。一緒に動く駒は戦闘しない。
  //   ★ 一緒に動いた駒自身の【運ぶ】は発動しない（連れて動くのは1体だけ）
  carryAlly: {
    applies(ctx, ab, pieceId, info) { return !!carryCompanion(ctx.s, ab, pieceId, info.from); },
    fire(ctx, ab, pieceId, info) {
      const comp = carryCompanion(ctx.s, ab, pieceId, info.from);
      const a = parseSquare(ctx.s, info.from);
      const b = parseSquare(ctx.s, info.to);
      const c = parseSquare(ctx.s, comp.sq);
      const x = c.x + (b.x - a.x);
      const y = c.y + (b.y - a.y);
      const dest = inBoard(ctx.s, x, y) ? squareName(ctx.s, x, y) : null;
      if (!dest || pieceAt(ctx.s, dest)) {
        ctx.s = addStat(ctx.s, 'carryBlocked');
        ctx.events.push({ type: 'carryBlocked', pieceId: comp.piece.id, from: comp.sq, to: dest, carrierId: pieceId });
        return;
      }
      ctx.s = setCell(setCell(ctx.s, comp.sq, null), dest, comp.piece.id);
      ctx.s = addStat(ctx.s, 'carried');
      const depth = markMoved(ctx, comp.piece.id, pieceId);
      ctx.events.push({ type: 'carried', pieceId: comp.piece.id, from: comp.sq, to: dest, carrierId: pieceId, depth });
      afterDisplaced(ctx, comp.piece.id, comp.sq, dest, 'byCarry', false);
    },
  },
  // 運ぶ（改）（CG-025）：発火点 onSelfMove（自分で動いたとき。攻撃で勝ってマスに入ったときも）。
  //   area の範囲（隣）にいる味方の駒（キングを除く）から1体を持ち主が選び、同じ向きに同じだけ一緒に動かす。
  //   候補は「行き先が空いている駒」だけ（choices）。選んだ駒は action.carry に入る（null＝運ばない）。
  //   手番の行動以外で発動したとき（rules.carryWhenMoved）は、候補の決め打ちの順番（areaInReadingOrder）の先頭を運ぶ。
  //   運ばれた駒は戦闘しない。★ 運ばれた駒自身の運ぶは発動しない（モック3の仮決め3と同じ）
  carryChosen: {
    choices(state, ab, carrierId, from, to, moved) {
      const carrier = state.pieces[carrierId];
      const a = parseSquare(state, from);
      const b = parseSquare(state, to);
      const out = [];
      for (const sq of areaInReadingOrder(state, ab.area, from, carrier.controller)) {
        const pc = pieceAt(state, sq);
        if (!pc || pc.id === carrierId || pc.controller !== carrier.controller || pc.kind === state.kingKind) continue;
        if (moved && moved.has(pc.id)) continue;
        const c = parseSquare(state, sq);
        const x = c.x + (b.x - a.x);
        const y = c.y + (b.y - a.y);
        if (!inBoard(state, x, y) || pieceAt(state, squareName(state, x, y))) continue;
        out.push({ sq, piece: pc, dest: squareName(state, x, y) });
      }
      return out;
    },
    pick(ctx, ab, pieceId, info) {
      const cands = this.choices(ctx.s, ab, pieceId, info.from, info.to, ctx.moved);
      if (pieceId === ctx.chooserId && ctx.choice !== undefined) {
        if (ctx.choice === null) return null;
        return cands.find((c) => c.sq === ctx.choice) || null;
      }
      return cands[0] || null;
    },
    applies(ctx, ab, pieceId, info) { return !!this.pick(ctx, ab, pieceId, info); },
    fire(ctx, ab, pieceId, info) {
      const c = this.pick(ctx, ab, pieceId, info);
      ctx.s = setCell(setCell(ctx.s, c.sq, null), c.dest, c.piece.id);
      ctx.s = addStat(ctx.s, 'carried');
      const depth = markMoved(ctx, c.piece.id, pieceId);
      ctx.events.push({ type: 'carried', pieceId: c.piece.id, from: c.sq, to: c.dest, carrierId: pieceId, depth, abilityId: ab.id });
      afterDisplaced(ctx, c.piece.id, c.sq, c.dest, 'byCarry', false);
    },
  },
  // すり抜け（CG-025）：常時。直線に動くとき味方を count 体まで飛び越えられる（movesFrom が読む）
  passAllies: { passAllies: true },
  // 爆風（CG-025）：発火点 onLanded（投げられて着地したとき）。area の範囲の駒をすべて、自分から見て外側へ1マス押す。
  //   ★ 押す順番は決め打ち（今の持ち主から見た読み順 areaInReadingOrder）。1つ押すたびに、その押しの連鎖を解き切ってから次へ
  //   （深さ優先）。各マスはその時点の盤で見る。押す・止まるの扱いは押し出しと同じ（pushStep）
  pushAround: {
    fire(ctx, ab, pieceId) {
      const center = pieceSquare(ctx.s, pieceId);
      if (!center) return;
      const owner = ctx.s.pieces[pieceId].controller;
      const c = parseSquare(ctx.s, center);
      for (const sq of areaInReadingOrder(ctx.s, ab.area, center, owner)) {
        if (ctx.s.result || pieceSquare(ctx.s, pieceId) !== center) return;
        if (!pieceAt(ctx.s, sq)) continue;
        const p = parseSquare(ctx.s, sq);
        pushStep(ctx, ab, pieceId, c, p.x - c.x, p.y - c.y);
      }
    },
  },
  // 道連れ（CG-025）：発火点 onMoved（動かされたとき）。動かされる前のマスで、動かされた向きと反対側の隣にいた敵1体を、
  //   同じ向きに同じだけ引きずる。そこに敵がいなければ何も起きない（発動に数えない）。
  //   ★ 引きずれない：キング（rules.kingPushable が false）・押されない駒（不動）・この連鎖で動いた駒。
  //   ★ 行き先に駒がいる：rules.dragBlocked（stay＝引きずらない（既定）／battle＝押し出しと同じく、引きずられた駒を攻撃側として戦闘）
  dragEnemy: {
    target(state, pieceId, info) {
      const a = parseSquare(state, info.from);
      const b = parseSquare(state, info.to);
      const vx = b.x - a.x;
      const vy = b.y - a.y;
      if (!(vx === 0 || vy === 0 || Math.abs(vx) === Math.abs(vy))) return null;   // 向きが定まらない（ナイトの跳び）
      const x = a.x - Math.sign(vx);
      const y = a.y - Math.sign(vy);
      if (!inBoard(state, x, y)) return null;
      const sq = squareName(state, x, y);
      const pc = pieceAt(state, sq);
      if (!pc || pc.controller === state.pieces[pieceId].controller) return null;
      return { sq, piece: pc, dest: inBoard(state, x + vx, y + vy) ? squareName(state, x + vx, y + vy) : null };
    },
    applies(ctx, ab, pieceId, info) { return !!this.target(ctx.s, pieceId, info); },
    fire(ctx, ab, pieceId, info) {
      const t = this.target(ctx.s, pieceId, info);
      const blocked = (why) => {
        ctx.s = addStat(ctx.s, 'dragBlocked');
        ctx.events.push({ type: 'dragBlocked', pieceId: t.piece.id, draggerId: pieceId, from: t.sq, to: t.dest, why, depth: depthOf(ctx, pieceId) + 1 });
      };
      if (t.piece.kind === ctx.s.kingKind && !ctx.s.rules.kingPushable) { blocked('king'); return; }
      if (blocksPush(ctx.s, t.piece)) { ctx.s = addFire(ctx.s, abilityOf(ctx.s, t.piece).id); blocked('blocked'); return; }
      if (ctx.moved.has(t.piece.id)) { blocked('alreadyMoved'); return; }
      if (!t.dest) { blocked('edge'); return; }
      const occupied = !!pieceAt(ctx.s, t.dest);
      if (occupied && ctx.s.rules.dragBlocked !== 'battle') { blocked('occupied'); return; }
      const depth = markMoved(ctx, t.piece.id, pieceId);
      ctx.s = addStat(ctx.s, 'dragged');
      ctx.events.push({ type: 'dragged', pieceId: t.piece.id, draggerId: pieceId, from: t.sq, to: t.dest, result: occupied ? 'battle' : 'moved', depth, abilityId: ab.id });
      if (occupied) {
        resolveBattle(ctx, t.sq, t.dest, true);
        afterDisplaced(ctx, t.piece.id, t.sq, t.dest, 'byDrag', true);
        return;
      }
      ctx.s = setCell(setCell(ctx.s, t.sq, null), t.dest, t.piece.id);
      afterDisplaced(ctx, t.piece.id, t.sq, t.dest, 'byDrag', false);
    },
  },
  // 入れ替え（CG-025）：発火点 action（手番の行動）。area の範囲（隣）の味方の駒（キングを除く）と位置を交換する。
  //   合法手は actions が作り、解決は resolveSwap。交換された相手は「動かされた」になる（入れ替える駒自身は自分の行動なので動かされていない）
  swapAlly: {
    actions(state, ab, swapper, swapperSq) {
      const out = [];
      for (const sq of areaSquares(state, ab.area, swapperSq)) {
        const t = pieceAt(state, sq);
        if (!t || t.controller !== swapper.controller || t.kind === state.kingKind) continue;
        out.push({ type: 'swap', from: swapperSq, to: sq });
      }
      return out;
    },
  },
  // 投げる（CG-024）：発火点 action（手番の行動として使う）。合法手は actions が作り、解決は resolveThrow
  throwAlly: {
    actions(state, ab, thrower, throwerSq) {
      const p = parseSquare(state, throwerSq);
      const out = [];
      for (const sq of areaSquares(state, ab.area, throwerSq)) {
        const t = pieceAt(state, sq);
        if (!t || t.controller !== thrower.controller || t.kind === state.kingKind || blocksThrow(state, t)) continue;
        const q = parseSquare(state, sq);
        const x = p.x + (p.x - q.x) * ab.distance;
        const y = p.y + (p.y - q.y) * ab.distance;
        if (!inBoard(state, x, y)) continue;
        const to = squareName(state, x, y);
        const at = pieceAt(state, to);
        if (at && at.controller === thrower.controller) continue;   // 味方の駒の上には投げられない
        out.push({ type: 'throw', from: sq, to });
      }
      return out;
    },
  },
};

/** 隣（ab.side：right＝今の持ち主から見て右）の駒。左右は今の持ち主の「前」から決める（寝返ると入れ替わる） */
function sideSquare(state, controller, sq, side) {
  const c = parseSquare(state, sq);
  const fwd = forwardOf(state, controller);
  // 前が行の減る向き（先手）なら右は列の増える向き（G 側）、前が行の増える向き（後手）なら右は A 側
  const dx = (side === 'left' ? 1 : -1) * fwd;
  const x = c.x + dx;
  return inBoard(state, x, c.y) ? squareName(state, x, c.y) : null;
}

/** 運ぶ：連れて動く駒（from の隣の味方。キングは運ばない）。なければ null */
function carryCompanion(state, ab, carrierId, from) {
  const carrier = state.pieces[carrierId];
  const sq = sideSquare(state, carrier.controller, from, ab.side);
  if (!sq) return null;
  const pc = pieceAt(state, sq);
  if (!pc || pc.id === carrierId || pc.controller !== carrier.controller || pc.kind === state.kingKind) return null;
  return { sq, piece: pc };
}

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

/** すり抜け（常時の効果 passAllies）で飛び越えられる味方の数（能力がなければ 0） */
function alliesPassable(state, piece) {
  const ab = abilityOf(state, piece);
  return ab && ab.trigger === 'static' && EFFECTS[ab.effect] && EFFECTS[ab.effect].passAllies ? (ab.count || 0) : 0;
}

/** from から to への直線の途中にいる駒のマス（ナイトの跳び・隣への移動なら空） */
function squaresBetween(state, from, to) {
  const a = parseSquare(state, from);
  const b = parseSquare(state, to);
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  if (!(dx === 0 || dy === 0 || Math.abs(dx) === Math.abs(dy))) return [];
  const ux = Math.sign(dx);
  const uy = Math.sign(dy);
  const out = [];
  for (let x = a.x + ux, y = a.y + uy; x !== b.x || y !== b.y; x += ux, y += uy) {
    const sq = squareName(state, x, y);
    if (pieceAt(state, sq)) out.push(sq);
  }
  return out;
}

/**
 * sq を中心とする area のマスを、controller から見た読み順（前の列の左→右、同じ列の左→右、後ろの列の左→右）で並べる（CG-025）。
 * 爆風の押す順番・運ぶ（改）の候補の順番（CPU が選ぶ順）に使う。★ 判断待ち：決め打ちの順番
 */
function areaInReadingOrder(state, areaKey, sq, controller) {
  const sqs = areaSquares(state, areaKey, sq).sort((a, b) => squareIndex(state, a) - squareIndex(state, b));
  // 先手は前が行の減る向き・右が G 側なので盤の順そのまま。後手は前が行の増える向き・右が A 側なので逆順
  return forwardOf(state, controller) < 0 ? sqs : sqs.reverse();
}

/** 押し出しで押されないか（常時の効果 blocksPush） */
function blocksPush(state, piece) {
  const ab = abilityOf(state, piece);
  return !!(ab && ab.trigger === 'static' && EFFECTS[ab.effect] && EFFECTS[ab.effect].blocksPush);
}

/** 投げられない駒か（常時の効果 blocksThrow） */
function blocksThrow(state, piece) {
  const ab = abilityOf(state, piece);
  return !!(ab && ab.trigger === 'static' && EFFECTS[ab.effect] && EFFECTS[ab.effect].blocksThrow);
}

/** 投げる（action）の投げる駒のマス：from（投げられる駒）と to（着地点）の間。投げでなければ null */
function throwerSquare(state, from, to) {
  const a = parseSquare(state, from);
  const b = parseSquare(state, to);
  if (!a || !b) return null;
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  // 投げる駒は from の隣で、to はそこからさらに同じ向きに distance マス先。distance は能力ごとに違いうるので
  // 1マス先の駒の能力の distance で確かめる
  const ux = Math.sign(dx);
  const uy = Math.sign(dy);
  if (!inBoard(state, a.x + ux, a.y + uy)) return null;
  const sq = squareName(state, a.x + ux, a.y + uy);
  const pc = pieceAt(state, sq);
  const ab = pc ? abilityOf(state, pc) : null;
  if (!ab || ab.trigger !== 'action' || !ab.distance) return null;
  if (dx !== ux * (1 + ab.distance) || dy !== uy * (1 + ab.distance)) return null;
  return sq;
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
function kingFallsBy(state, from, to, carry) {
  // 攻撃でない移動は、動く駒が発火点のある能力を持つときだけ読む（運ぶ（改）→ 道連れの連鎖など。CG-025）
  if (!battleOutcome(state, from, to)) {
    const ab = pieceAt(state, from) ? abilityOf(state, pieceAt(state, from)) : null;
    if (!ab || ab.trigger === 'static') return null;
  }
  return fallenKing(previewMove(state, from, to, carry).result);
}

function fallenKing(r) {
  if (!r) return null;
  if (r.reason === 'bothKings') return 'both';
  return opponentOf(r.winner);
}

/**
 * 手番の行動（move・throw・swap）で倒れるキングの持ち主（'p1' | 'p2' | 'both' | null）。
 * 投げる・入れ替えは打つ前の結果予測（実際の解決と同じ関数）で読む。AI・view はこれに訊く（CG-024）。
 * ★ 投げるは空きマスへの着地でも読む（爆風の押しの先でキングが倒れうる。CG-025）
 */
function kingFallsByAction(state, action) {
  if (action.type === 'move') return kingFallsBy(state, action.from, action.to, action.carry);
  if (action.type !== 'throw' && action.type !== 'swap') return null;
  return fallenKing(previewAction(state, action).result);
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
    for (const m of movesFrom(state, sq)) {
      const opts = carryOptions(state, sq, m.to);
      if (!opts) { out.push({ type: 'move', from: sq, to: m.to }); continue; }
      // 運ぶ（改）：一緒に動かす駒の選択も手の一部（候補の決め打ちの順番 → 運ばない、の順。CPU は先頭を使う）
      for (const c of opts) out.push({ type: 'move', from: sq, to: m.to, carry: c });
    }
  }
  // 手番の行動として使う能力（投げる・CG-024／入れ替え・CG-025）。★ 移動の後・置くの前に並べる（モック2以前の並びは変わらない）
  for (const sq of allSquares(state)) {
    const pc = pieceAt(state, sq);
    if (!pc || pc.controller !== playerId) continue;
    const ab = abilityOf(state, pc);
    if (!ab || ab.trigger !== 'action') continue;
    const fx = EFFECTS[ab.effect];
    if (fx && fx.actions) out.push(...fx.actions(state, ab, pc, sq));
  }
  const hand = state.players[playerId].hand || [];
  for (const id of hand) {
    for (const to of placementSquares(state, playerId, id)) out.push({ type: 'place', pieceId: id, to });
  }
  if (state.rules.drawMode === 'action' && deckCount(state, playerId) > 0) out.push({ type: 'draw' });
  if (out.length === 0) out.push({ type: 'pass' });
  return out;
}

/**
 * 運ぶ（改）（発火点 onSelfMove で choices を持つ効果）の駒を from → to へ動かす手の、carry の選択肢（CG-025）。
 *   選ぶものがない移動（能力がない・候補がない・攻撃で勝てない・キングを倒して決着する）なら null。
 *   候補はその駒が to に入った後の盤で決める（実際の解決と同じ choices を通す）。
 *   候補が2体以上：候補の順番 ＋ null（運ばない）。1体：その1体だけ（自動。rules.carryDeclineSingle なら null も）
 */
function carryOptions(state, from, to) {
  const pc = pieceAt(state, from);
  const ab = pc ? abilityOf(state, pc) : null;
  if (!ab || ab.trigger !== 'onSelfMove') return null;
  const fx = EFFECTS[ab.effect];
  if (!fx || !fx.choices) return null;
  const def = pieceAt(state, to);
  if (def && (battleOutcome(state, from, to) !== 'win' || def.kind === state.kingKind)) return null;
  const after = setCell(setCell(state, from, null), to, pc.id);
  const cands = fx.choices(after, ab, pc.id, from, to, null).map((c) => c.sq);
  if (cands.length === 0) return null;
  if (cands.length === 1 && !state.rules.carryDeclineSingle) return cands;
  return [...cands, null];
}

/** 能力を使う手番の行動（throw・swap）の、能力を持つ駒のマス。それ以外の手なら null（view が使う） */
function actionSource(state, action) {
  if (action.type === 'throw') return throwerSquare(state, action.from, action.to);
  if (action.type === 'swap') return action.from;
  return null;
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
  const frontBase = cardData.frontBase ? { moveType: cardData.frontBase.moveType, area: cardData.frontBase.area } : null;
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
    frontBase,
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
    // モック3（CG-024）
    throws: 0,          // 投げた回数
    throwBattles: 0,    // 投げて戦闘になった回数
    throwWins: 0,       // そのうち投げられた駒が勝った回数
    throwTies: 0,       // そのうち同値
    carried: 0,         // 運ぶで一緒に動いた回数
    carryBlocked: 0,    // 運ぶの隣に味方がいたが、行き先が空いておらず一緒に動かなかった回数
    frontBasePlaces: 0, // 前線基地で加わったマス（普段の置き場所ではないマス）に置いた回数
    // モック4（CG-025）
    swaps: 0,           // 入れ替えた回数
    dragged: 0,         // 道連れで敵を引きずった回数
    dragBlocked: 0,     // 道連れの後ろに敵がいたが、引きずれなかった回数（キング・不動・行き先に駒・この連鎖で動いた）
    allyPasses: 0,      // すり抜けで味方を飛び越えて動いた回数
    // 能力ごとの発動回数。常時の効果（鼓舞・槍衾・威圧）は「戦闘に参加した駒の実際の強さに効いた回数」、
    // 不動は「押し出しを止めた回数」、運ぶは「隣に連れて動く味方がいた回数」（実際に動いたのは carried）、
    // 投げるは「投げた回数」、それ以外は発火点で発動した回数
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
    case 'move': return afterMainAction(settlePending(resolveMove(state, action.from, action.to, false, action.carry).state));
    case 'throw': return afterMainAction(settlePending(resolveThrow(state, action.from, action.to, false).state));
    case 'swap': return afterMainAction(settlePending(resolveSwap(state, action.from, action.to, false).state));
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
  // carry（運ぶ（改）の選択・CG-025）：付いていない＝''、null（運ばない）＝'-'
  return [a.type, a.from || '', a.to || '', a.pieceId || '', a.keep === undefined ? '' : a.keep, a.carry === undefined ? '' : a.carry === null ? '-' : a.carry].join('|');
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
  const viaFrontBase = !basicPlacementSquares(state, pid, action.pieceId).includes(action.to);
  let s = setCell(state, action.to, action.pieceId);
  s = setPiece(s, action.pieceId, { controller: pid });
  s = setPlayer(s, pid, { hand: s.players[pid].hand.filter((id) => id !== action.pieceId) });
  s = { ...s, lastEvents: [{ type: 'place', player: pid, pieceId: action.pieceId, to: action.to, ...(viaFrontBase ? { frontBase: true } : {}) }] };
  s = addStat(s, 'places');
  return viaFrontBase ? addStat(s, 'frontBasePlaces') : s;
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

/**
 * 解決中の文脈。s は不変の state を差し替えていく（既存の state は書き換えない）。
 *   moved   … この手（1回の連鎖）ですでに動いた駒。★ 打ち切り：同じ駒が動くのは1度まで（押す・引きずる・運ぶの相手から外す）
 *   depthOf … 能力で動かされた駒が何段目の動きか（手番の行動で動いた駒・投げる駒は 0。CG-025）
 *   chooserId / choice … 手番の行動で動いた駒と、その手の carry（運ぶ（改）の選択）
 */
function makeCtx(state, preview) {
  return { s: state, events: [], moved: new Set(), preview: !!preview, chain: null, actor: state.active, depthOf: new Map(), maxDepth: 0, chooserId: null, choice: undefined };
}

function depthOf(ctx, id) {
  return ctx.depthOf.get(id) || 0;
}

/** id の駒が sourceId の駒の能力で動かされた：この連鎖で動いた駒に入れ、段（source の段 + 1）を記録して返す */
function markMoved(ctx, id, sourceId) {
  const d = depthOf(ctx, sourceId) + 1;
  ctx.moved.add(id);
  ctx.depthOf.set(id, d);
  if (d > ctx.maxDepth) ctx.maxDepth = d;
  return d;
}

/** 発火点 trigger で piece の能力を発動する（能力がなければ何もしない） */
function fireTrigger(ctx, trigger, pieceId, info) {
  if (ctx.s.result) return;
  const ab = abilityOf(ctx.s, ctx.s.pieces[pieceId]);
  if (!ab || ab.trigger !== trigger) return;
  const fx = EFFECTS[ab.effect];
  if (!fx || !fx.fire) return;
  if (fx.applies && !fx.applies(ctx, ab, pieceId, info || {})) return;   // 発動の条件がない（運ぶの隣に味方がいない）
  ctx.s = addFire(ctx.s, ab.id);
  ctx.events.push({ type: 'ability', abilityId: ab.id, trigger, pieceId, depth: depthOf(ctx, pieceId) });
  fx.fire(ctx, ab, pieceId, info || {});
}

/**
 * 能力で動かされた駒（from から to へ動き、盤上の to に止まった）の発火点を発動する（CG-025）。
 *   cause … byPush（押し出し・反動・爆風）／byThrow／byCarry／bySwap／byDrag。battled … 動いた先で戦闘をして勝って入った
 * ★ 同じ瞬間に複数の駒が動かされたときの順番（判断待ち）：動かされた駒ごとに、その場でこの関数を通して
 *   能力を解き切ってから次の駒へ進む（深さ優先）。爆風の8マスも1マスずつ（pushAround）。
 * ★ 戦闘に負けた・盤の外へ出た駒は、盤上で止まっていないので発動しない。
 * 1つの駒の能力は1つなので、ここで発動するのは多くて1つ。並びは：
 *   【攻撃でない移動】（モック3の運ぶ。rules.carryWhenMoved のときだけ・戦闘なし・運ばれたのではないとき）
 *   → 【押されたとき】（cause が push）→【投げられて着地したとき】（cause が throw）→【動かされたとき】（すべて）
 */
function afterDisplaced(ctx, id, from, to, cause, battled) {
  if (ctx.s.result || pieceSquare(ctx.s, id) !== to) return;
  const info = { from, to, cause };
  if (ctx.s.rules.carryWhenMoved && !battled && cause !== 'byCarry') {
    fireTrigger(ctx, 'onMove', id, info);
    fireTrigger(ctx, 'onSelfMove', id, info);
  }
  if (cause === 'byPush') fireTrigger(ctx, 'onPushed', id, info);
  if (cause === 'byThrow') fireTrigger(ctx, 'onLanded', id, info);
  fireTrigger(ctx, 'onMoved', id, info);
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
    type: 'battle', player: ctx.actor, from, to, chain: !!chain, depth: depthOf(ctx, attacker.id),
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
  // 攻めて負けた駒は、動く前のマスで倒れる。★ 投げられて負けた駒は rules.thrownLoserFallsAt（CG-024・曖昧な点の仮決め。
  //   既定 origin＝投げられる前のマス。landing＝着地点）。今の能力で効くのは裏切り者の【寝返り時】の位置だけ
  const defeatedSq = win ? to : ctx.thrownLanding && ctx.s.rules.thrownLoserFallsAt === 'landing' && from === ctx.thrownLanding.from ? to : from;
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
  startPushChain(ctx, to);
  // 向きが定まらない攻め（ナイトの跳び）では押せない。★ 今の駒構成ではナイトに押し出しは付いていない
  if (!(dx === 0 || dy === 0 || Math.abs(dx) === Math.abs(dy))) { pushStop(ctx, pusherId, 'noDirection'); return; }
  pushStep(ctx, ab, pusherId, b, Math.sign(dx), Math.sign(dy));
}

function startPushChain(ctx, origin) {
  if (ctx.chain) return;
  ctx.chain = { length: 0, offBoard: 0, battles: 0, stoppedBy: null, origin };
  ctx.s = addStat(ctx.s, 'pushChains');
}

function pushStop(ctx, pusherId, why, at) {
  ctx.chain.stoppedBy = why;
  ctx.events.push({ type: 'pushStop', why, at: at || null, pusherId });
}

/**
 * 1マス押す（CG-025 で押し出しから切り出し。押し出し・反動・爆風が共通に使う）：
 *   b（解析済みのマス）の (ux, uy) 向きの隣の駒を、その向きに1マス押す。押したのは pusherId の駒の能力 ab。
 *   押された駒は「押された」「動かされた」（afterDisplaced）。何段目かは pusherId の段 + 1
 */
function pushStep(ctx, ab, pusherId, b, ux, uy) {
  if (ctx.s.result) return;
  startPushChain(ctx, squareName(ctx.s, b.x, b.y));
  const stop = (why, at) => pushStop(ctx, pusherId, why, at);
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
  const depth = markMoved(ctx, target.id, pusherId);
  ctx.chain.length++;
  ctx.s = addStat(ctx.s, 'pushedPieces');
  const x2 = b.x + 2 * ux;
  const y2 = b.y + 2 * uy;
  if (!inBoard(ctx.s, x2, y2)) {
    // 盤の外：倒されたとして扱い、元の持ち主の山へ（取られた側ドラフトも起きる）
    ctx.s = setCell(ctx.s, sq1, null);
    ctx.chain.offBoard++;
    ctx.s = addStat(ctx.s, 'pushOffBoard');
    ctx.events.push({ type: 'pushed', pieceId: target.id, from: sq1, to: null, result: 'offBoard', pusherId, depth, abilityId: ab.id });
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
    ctx.events.push({ type: 'pushed', pieceId: target.id, from: sq1, to: sq2, result: 'moved', pusherId, depth, abilityId: ab.id });
    stop('moved', sq2);
    // 押された駒の発火点（反動【押されたとき】・道連れ【動かされたとき】）。★ モック3の運ぶ（押されて動いたとき）は
    //   rules.carryWhenMoved のときだけ（CG-024・曖昧な点の仮決め。既定は発動しない）。afterDisplaced が扱う
    afterDisplaced(ctx, target.id, sq1, sq2, 'byPush', false);
    return;
  }
  ctx.chain.battles++;
  ctx.chain.stoppedBy = 'battle';   // 押された駒がさらに押し出せば、その段の止まり方で上書きされる
  ctx.events.push({ type: 'pushed', pieceId: target.id, from: sq1, to: sq2, result: 'battle', pusherId, depth, abilityId: ab.id });
  resolveBattle(ctx, sq1, sq2, true);
  // 押された駒が勝てば、その駒の【攻めて勝ったとき】が resolveBattle の中で発動する（連鎖）。
  // 勝って sq2 に止まったなら、さらに【押されたとき】【動かされたとき】（CG-025）
  afterDisplaced(ctx, target.id, sq1, sq2, 'byPush', true);
}

/** 解決の結果を返す形にそろえる（移動・投げる・入れ替えの共通） */
function finishCtx(ctx) {
  if (ctx.chain) ctx.events.push({ type: 'pushChain', ...ctx.chain });
  return { state: { ...ctx.s, lastEvents: ctx.events }, events: ctx.events, chain: ctx.chain, maxDepth: ctx.maxDepth };
}

/**
 * 移動・攻撃を解決する。reduce と previewMove の共通の入口。
 * @param {string|null|undefined} carry 運ぶ（改）で一緒に動かす駒のマス（null＝運ばない・undefined＝選択なし）
 * @returns {{ state: object, events: object[], chain: object|null, maxDepth: number }}
 */
function resolveMove(state, from, to, preview, carry) {
  const ctx = makeCtx(state, preview);
  const attacker = pieceAt(state, from);
  const defender = pieceAt(state, to);
  ctx.chooserId = attacker.id;
  ctx.choice = carry;
  ctx.s = addStat(ctx.s, 'moves');
  ctx.moved.add(attacker.id);
  // すり抜け（CG-025）：途中の味方を飛び越えた移動（movesFrom がすり抜けの駒にだけ許している）
  const over = alliesPassable(state, attacker) > 0 ? squaresBetween(state, from, to) : [];
  if (over.length > 0) {
    ctx.s = addFire(ctx.s, abilityOf(state, attacker).id);
    ctx.s = addStat(ctx.s, 'allyPasses');
    for (const sq of over) ctx.events.push({ type: 'passed', pieceId: attacker.id, overId: pieceAt(state, sq).id, at: sq, depth: 0 });
  }
  if (!defender) {
    ctx.s = setCell(setCell(ctx.s, from, null), to, attacker.id);
    ctx.events.push({ type: 'move', player: ctx.actor, pieceId: attacker.id, from, to });
    // 【攻撃でない移動】（運ぶ・CG-024）。★ 手番の行動で動いたとき。押し出し・投げられて動いたときは rules.carryWhenMoved のときだけ
    fireTrigger(ctx, 'onMove', attacker.id, { from, to });
  } else {
    resolveBattle(ctx, from, to, false);
  }
  // 【自分で動いたとき】（運ぶ（改）・CG-025）：攻撃なら、勝ってそのマスに入ったときだけ
  if (pieceSquare(ctx.s, attacker.id) === to) fireTrigger(ctx, 'onSelfMove', attacker.id, { from, to });
  return finishCtx(ctx);
}

/**
 * 打つ前の結果予測（CG-023）。view と CPU はこれだけを使う。
 * 実際の解決と同じ resolveMove を、山・手札を動かさずに通す（フィルタ済みの state でも動く）。
 * @returns {{ cells: Array, result: object|null, events: object[], chain: object|null, maxDepth: number }}
 */
function previewMove(state, from, to, carry) {
  return previewOf(resolveMove(state, from, to, true, carry));
}

function previewOf(r) {
  return { cells: r.state.cells, result: r.state.result, events: r.events, chain: r.chain, pieces: r.state.pieces, maxDepth: r.maxDepth };
}

/**
 * 投げる（CG-024）を解決する。reduce と previewThrow の共通の入口。
 *   from＝投げられる駒のマス、to＝着地点。投げる駒は間（throwerSquare）。投げる駒自身は動かない。
 *   着地点が空き → そこへ置く ／ 敵 → 投げられた駒を攻撃側として戦闘（resolveBattle(from, to) をそのまま通す：
 *   実際の強さは投げられる前のマスでの値、勝てば着地点に入る、押し出しの向きは投げた向き、
 *   ★ 負けたときは投げられる前のマス（from）で倒れたとして扱う＝攻めて負けた駒と同じ）
 *   着地点に止まったら【投げられて着地したとき】（爆風）・【動かされたとき】（道連れ）（CG-025。afterDisplaced）
 * @returns {{ state: object, events: object[], chain: object|null, maxDepth: number }}
 */
function resolveThrow(state, from, to, preview) {
  const ctx = makeCtx(state, preview);
  const throwerSq = throwerSquare(state, from, to);
  const thrower = pieceAt(state, throwerSq);
  const thrown = pieceAt(state, from);
  const defender = pieceAt(state, to);
  const ab = abilityOf(state, thrower);
  ctx.s = addStat(ctx.s, 'throws');
  ctx.s = addFire(ctx.s, ab.id);
  const depth = markMoved(ctx, thrown.id, thrower.id);
  ctx.events.push({ type: 'throw', player: ctx.actor, throwerId: thrower.id, pieceId: thrown.id, from, via: throwerSq, to, landing: defender ? 'battle' : 'empty', depth });
  if (!defender) {
    ctx.s = setCell(setCell(ctx.s, from, null), to, thrown.id);
    // ★ 投げられて動いた駒の【攻撃でない移動】（運ぶ）は rules.carryWhenMoved のときだけ（既定は発動しない）。afterDisplaced が扱う
    afterDisplaced(ctx, thrown.id, from, to, 'byThrow', false);
  } else {
    ctx.thrownLanding = { from, to };
    ctx.s = addStat(ctx.s, 'throwBattles');
    const n = ctx.events.length;
    resolveBattle(ctx, from, to, false);
    const b = ctx.events.slice(n).find((e) => e.type === 'battle');
    if (b && b.outcome === 'win') ctx.s = addStat(ctx.s, 'throwWins');
    if (b && b.outcome === 'tie') ctx.s = addStat(ctx.s, 'throwTies');
    afterDisplaced(ctx, thrown.id, from, to, 'byThrow', true);
  }
  return finishCtx(ctx);
}

/** 投げるの打つ前の結果予測（実際の解決と同じ resolveThrow を、山・手札を動かさずに通す） */
function previewThrow(state, from, to) {
  return previewOf(resolveThrow(state, from, to, true));
}

/**
 * 入れ替え（CG-025）を解決する。reduce と previewSwap の共通の入口。
 *   from＝入れ替える駒のマス、to＝隣の味方のマス。2つの駒の位置を交換する。
 *   交換された相手（to にいた駒）は「動かされた」（afterDisplaced。1段目）。入れ替える駒は自分の行動なので動かされていない
 * @returns {{ state: object, events: object[], chain: object|null, maxDepth: number }}
 */
function resolveSwap(state, from, to, preview) {
  const ctx = makeCtx(state, preview);
  const swapper = pieceAt(state, from);
  const partner = pieceAt(state, to);
  ctx.s = addStat(ctx.s, 'swaps');
  ctx.s = addFire(ctx.s, abilityOf(state, swapper).id);
  ctx.s = setCell(setCell(ctx.s, from, partner.id), to, swapper.id);
  ctx.moved.add(swapper.id);
  const depth = markMoved(ctx, partner.id, swapper.id);
  ctx.events.push({ type: 'swap', player: ctx.actor, swapperId: swapper.id, pieceId: partner.id, from, to, depth });
  afterDisplaced(ctx, partner.id, to, from, 'bySwap', false);
  return finishCtx(ctx);
}

/** 入れ替えの打つ前の結果予測（実際の解決と同じ resolveSwap を、山・手札を動かさずに通す） */
function previewSwap(state, from, to) {
  return previewOf(resolveSwap(state, from, to, true));
}

/** 手番の行動（move・throw・swap）の打つ前の結果予測。view・CPU・ハーネスはこれを使う（CG-024・CG-025） */
function previewAction(state, action) {
  if (action.type === 'move') return previewMove(state, action.from, action.to, action.carry);
  if (action.type === 'throw') return previewThrow(state, action.from, action.to);
  if (action.type === 'swap') return previewSwap(state, action.from, action.to);
  return null;
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
    frontBase: state.frontBase,
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
  basicPlacementSquares,
  frontBaseSquares,
  pieceSquare,
  abilityOf,
  inArea,
  areaSquares,
  strengthBreakdown,
  effectiveStrength,
  blocksPush,
  blocksThrow,
  throwerSquare,
  battleOutcome,
  kingFallsBy,
  kingFallsByAction,
  previewMove,
  previewThrow,
  previewSwap,
  previewAction,
  carryOptions,
  actionSource,
  areaInReadingOrder,
  squaresBetween,
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

  // ★ モック1の検査は駒構成をモック1に固定して行う（既定はモック3・CG-024）。
  //   前線基地（CG-024・どの駒構成でも効く）は、モック1・モック2 の検査では切る（CG-023 までの振る舞いのまま検査する）
  const M1 = { pieceSet: 'mock1', frontBase: false };
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
    if (!id) throw new Error(`検査の駒が足りません: ${owner} ${kind}`);
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

  console.log('engine.js セルフテスト（v0.3 モック1・モック2・モック3・モック4）');

  // --- データ ---
  {
    for (const key of ['mock1', 'mock2', 'mock3', 'mock4']) {
      const total = cardData.pieceSets[key].list.reduce((n, d) => n + d.count, 0);
      check(`データ: ${key} の山は16枚`, total === 16);
    }
    check('データ: 駒構成の既定はモック4（CG-025）・前線基地は既定でオン', defaultSettings(cardData).pieceSet === 'mock4' && defaultSettings(cardData).frontBase === true && createInitialState(1, cardData).version === cardData.version);
    // 推奨設定（CG-025）：既定に3項目だけを上書きする。どの値もデバッグパネルの選択肢にある
    const rec = cardData.recommended.settings;
    check('データ: 推奨設定はモック4・キング6・勝った側が減る（それ以外は既定のまま）',
      rec.pieceSet === 'mock4' && rec.kingStrength === 6 && rec.winnerLosesStrength === true && Object.keys(rec).length === 3);
    check('データ: 推奨設定の値はどれもデバッグパネルの選択肢にある',
      Object.keys(rec).every((k) => cardData.flags.list.some((f) => f.key === k && f.choices.some((c) => c.value === rec[k]))));
    check('データ: 推奨設定は既定値を変えていない（既定のキングは強さ3・減らない）', cardData.king.strength === 3 && cardData.rules.winnerLosesStrength === false);
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
  const M2 = { pieceSet: 'mock2', frontBase: false };
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
    const mock2Abilities = [...new Set(cardData.pieceSets.mock2.list.map((d) => d.ability).filter(Boolean))];
    check('能力: 自動対戦でモック2の8種すべてが1回以上発動している', mock2Abilities.length === 8 && mock2Abilities.every((k) => fired[k] > 0));
    check('不変条件(モック2): 駒の総数は常に34', total);
    check('不変条件(モック2): 基礎の強さ・実際の強さは0未満にならない', nonNeg);
    check('フィルタ(モック2): 相手の手札・両者の山・相手のドラフトの2枚が含まれない（イベントの入れ子も）', !leaked);
    check('フィルタ(モック2): フィルタ後の state でも本人の合法手は同じ', legalSame);
  }

  // =========================================================================
  // モック3（CG-024）：運ぶ・投げる・前線基地
  // =========================================================================
  const M3 = { pieceSet: 'mock3', frontBase: true };
  const blank3 = (overrides, opts) => blank({ ...M3, ...overrides }, opts);
  const hasThrow = (s, from, to) => legalActions(s, s.active).some((a) => a.type === 'throw' && a.from === from && a.to === to);
  /** 投げるの予測（previewThrow）と実際の解決（reduce）の盤・決着が一致するか */
  const sameAsThrowPreview = (s, from, to) => {
    const pv = previewThrow(filterStateFor(s, s.active), from, to);
    const n = reduce(s, { type: 'throw', from, to });
    return JSON.stringify(pv.cells) === JSON.stringify(n.cells) && JSON.stringify(pv.result && { ...pv.result }) === JSON.stringify(n.result && { ...n.result });
  };
  /** 検査用：駒の種類 kind の能力を ability に付け替えた state（data は書き換えない） */
  const withAbility = (s, kind, ability) => ({ ...s, defs: { ...s.defs, [kind]: { ...s.defs[kind], ability } } });

  // --- 運ぶ ---
  {
    // 右隣（先手から見て G 側）の味方が一緒に動く
    let s = blank3();
    let t = put(s, 'p1', 'pawnCarry', 'C5'); s = t.s; const car = t.id;
    t = put(s, 'p1', 'pawn', 'D5'); s = t.s; const comp = t.id;
    t = put(s, 'p1', 'pawn', 'B5'); s = t.s; const left = t.id;
    s = { ...s, active: 'p1' };
    check('運ぶ(予測): 予測と実際の解決が一致する（一緒に動く）', sameAsPreview(s, 'C5', 'C4'));
    let n = reduce(s, { type: 'move', from: 'C5', to: 'C4' });
    check('運ぶ: 右隣（先手は G 側）の味方が同じ向きに同じだけ動く（D5→D4）', pieceAt(n, 'C4').id === car && pieceAt(n, 'D4').id === comp && !pieceAt(n, 'D5'));
    check('運ぶ: 左隣（B5）は動かない・発動1回', pieceAt(n, 'B5').id === left && n.stats.fires.hurl === 0 && n.stats.fires.carry === 1 && n.stats.carried === 1);
    check('運ぶ: 一緒に動くのは手を使わない（手数は1つだけ進む）', n.ply === 1);
    // 右隣がいない
    s = blank3();
    t = put(s, 'p1', 'pawnCarry', 'C5'); s = t.s;
    n = reduce({ ...s, active: 'p1' }, { type: 'move', from: 'C5', to: 'C4' });
    check('運ぶ: 右隣に駒がいなければ何も起きない（発動に数えない）', n.stats.fires.carry === 0 && n.stats.carried === 0 && n.stats.carryBlocked === 0);
    // 右隣が敵
    s = blank3();
    t = put(s, 'p1', 'pawnCarry', 'C5'); s = t.s;
    t = put(s, 'p2', 'pawn', 'D5'); s = t.s;
    n = reduce({ ...s, active: 'p1' }, { type: 'move', from: 'C5', to: 'C4' });
    check('運ぶ: 右隣が敵なら運ばない', pieceAt(n, 'D5') && pieceAt(n, 'D5').controller === 'p2' && n.stats.fires.carry === 0);
    // 行き先が塞がっている
    s = blank3();
    t = put(s, 'p1', 'pawnCarry', 'C5'); s = t.s;
    t = put(s, 'p1', 'pawn', 'D5'); s = t.s; const blk = t.id;
    t = put(s, 'p2', 'pawn', 'D4'); s = t.s;
    s = { ...s, active: 'p1' };
    check('運ぶ(予測): 予測と実際の解決が一致する（行き先が塞がっている）', sameAsPreview(s, 'C5', 'C4'));
    n = reduce(s, { type: 'move', from: 'C5', to: 'C4' });
    check('運ぶ: 行き先に駒がいれば一緒には動かない（運ぶ駒は普通に動く・戦闘しない）', pieceAt(n, 'C4').id === car && pieceAt(n, 'D5').id === blk && pieceAt(n, 'D4').controller === 'p2' && n.stats.battles === 0 && n.stats.carryBlocked === 1);
    // 盤の外（運ぶを付けたビショップで斜めに動く。検査用に能力を付け替える）
    s = withAbility(blank3(), 'bishopIntimidate', 'carry');
    t = put(s, 'p1', 'bishopIntimidate', 'F5'); s = t.s;
    t = put(s, 'p1', 'pawn', 'G5'); s = t.s; const edge = t.id;
    n = reduce({ ...s, active: 'p1' }, { type: 'move', from: 'F5', to: 'G4' });
    check('運ぶ: 行き先が盤の外なら一緒には動かない（F5→G4 で G5→H4 は盤外）', pieceAt(n, 'G4') && pieceAt(n, 'G5').id === edge && n.stats.carryBlocked === 1);
    // 行き先は運ぶ駒が動いた後の盤で見る（運ぶ駒が空けたマスへは動ける）
    s = withAbility(blank3(), 'bishopIntimidate', 'carry');
    s = withAbility(s, 'rookImmovable', 'carry');
    t = put(s, 'p1', 'rookImmovable', 'D5'); s = t.s;
    t = put(s, 'p1', 'pawn', 'E5'); s = t.s; const follow = t.id;
    n = reduce({ ...s, active: 'p1' }, { type: 'move', from: 'D5', to: 'A5' });
    check('運ぶ: 運ぶ駒が空けたマスへも一緒に動ける（D5→A5 で E5→B5）', pieceAt(n, 'B5') && pieceAt(n, 'B5').id === follow);
    // 攻撃のときは発動しない
    s = blank3();
    t = put(s, 'p1', 'pawnCarry', 'C5'); s = t.s;
    t = put(s, 'p1', 'pawn', 'D5'); s = t.s; const stay = t.id;
    t = put(s, 'p2', 'pawn', 'B4'); s = t.s;
    t = put(s, 'p1', 'queenInspire', 'C6'); s = t.s;
    n = reduce({ ...s, active: 'p1' }, { type: 'move', from: 'C5', to: 'B4' });
    check('運ぶ: 攻撃のときは発動しない', pieceAt(n, 'B4').id === car && pieceAt(n, 'D5').id === stay && n.stats.fires.carry === 0);
    // 後手の右は A 側
    s = blank3();
    t = put(s, 'p2', 'pawnCarry', 'C3'); s = t.s;
    t = put(s, 'p2', 'pawn', 'B3'); s = t.s; const p2r = t.id;
    t = put(s, 'p2', 'pawn', 'D3'); s = t.s; const p2l = t.id;
    n = reduce({ ...s, active: 'p2' }, { type: 'move', from: 'C3', to: 'C4' });
    check('運ぶ: 後手の右は A 側（B3→B4 が動き、D3 は動かない）', pieceAt(n, 'B4').id === p2r && pieceAt(n, 'D3').id === p2l);
    // 寝返ったら左右が入れ替わる（後手の運ぶポーンが先手に寝返っている）
    s = blank3();
    t = put(s, 'p2', 'pawnCarry', 'C5', 'p1'); s = t.s; const turned = t.id;
    t = put(s, 'p1', 'pawn', 'D5'); s = t.s; const nowRight = t.id;
    t = put(s, 'p1', 'pawn', 'B5'); s = t.s; const nowLeft = t.id;
    n = reduce({ ...s, active: 'p1' }, { type: 'move', from: 'C5', to: 'C4' });
    check('運ぶ: 寝返ると左右も入れ替わる（今の持ち主＝先手から見た右の D5 が動く）', pieceAt(n, 'C4').id === turned && pieceAt(n, 'D4').id === nowRight && pieceAt(n, 'B5').id === nowLeft);
    // キングは運ばない
    s = blank3();
    t = put(s, 'p1', 'pawnCarry', 'C7'); s = t.s;
    n = reduce({ ...s, active: 'p1' }, { type: 'move', from: 'C7', to: 'C6' });
    check('運ぶ: キング（右隣の D7）は運ばない', pieceAt(n, 'D7').id === 'p1-K' && n.stats.fires.carry === 0);
    // 一緒に動いた駒の【運ぶ】は発動しない（連れて動くのは1体だけ）
    s = blank3();
    t = put(s, 'p1', 'pawnCarry', 'C5'); s = t.s;
    t = put(s, 'p1', 'pawnCarry', 'D5'); s = t.s; const mid = t.id;
    t = put(s, 'p1', 'pawn', 'E5'); s = t.s; const far = t.id;
    n = reduce({ ...s, active: 'p1' }, { type: 'move', from: 'C5', to: 'C4' });
    check('運ぶ: 一緒に動いた駒の運ぶは連鎖しない（D5 は動き、E5 は動かない）', pieceAt(n, 'D4').id === mid && pieceAt(n, 'E5').id === far && n.stats.fires.carry === 1);
    // 押し出しで動かされたときは発動しない
    s = blank3();
    t = put(s, 'p1', 'rookPush', 'D7'); s = t.s;   // キングは D7 なので別の場所へ
    s = setCell(setCell(s, 'D7', null), 'A7', 'p1-K');
    s = setCell(s, 'D7', t.id);
    t = put(s, 'p2', 'pawn', 'D5'); s = t.s;
    t = put(s, 'p1', 'pawnCarry', 'D4'); s = t.s; const pushedCarry = t.id;
    t = put(s, 'p1', 'pawn', 'E4'); s = t.s; const notCarried = t.id;
    n = reduce({ ...s, active: 'p1' }, { type: 'move', from: 'D7', to: 'D5' });
    check('運ぶ: 押し出しで動かされたときは発動しない（既定 carryWhenMoved=false。D4→D3 に押され、E4 は残る）', pieceAt(n, 'D3') && pieceAt(n, 'D3').id === pushedCarry && pieceAt(n, 'E4').id === notCarried && n.stats.fires.carry === 0);
    const cw = reduce({ ...s, active: 'p1', rules: { ...s.rules, carryWhenMoved: true } }, { type: 'move', from: 'D7', to: 'D5' });
    check('運ぶ: carryWhenMoved=true なら押されて動いたときも隣を連れていく（E4→E3）', pieceAt(cw, 'D3').id === pushedCarry && pieceAt(cw, 'E3') && pieceAt(cw, 'E3').id === notCarried && cw.stats.fires.carry === 1);
    const cwp = previewMove(filterStateFor({ ...s, active: 'p1', rules: { ...s.rules, carryWhenMoved: true } }, 'p1'), 'D7', 'D5');
    check('運ぶ(予測): carryWhenMoved=true でも予測と実際の解決が一致する', JSON.stringify(cwp.cells) === JSON.stringify(cw.cells));
    // 投げられて空きマスに着地した運ぶの駒（既定は連れていかない／フラグで連れていく）
    let tc = blank3();
    t = put(tc, 'p1', 'bishopHurl', 'D4'); tc = t.s;
    t = put(tc, 'p1', 'pawnCarry', 'D5'); tc = t.s;
    t = put(tc, 'p1', 'pawn', 'E5'); tc = { ...t.s, active: 'p1' }; const nb = t.id;
    const tn0 = reduce(tc, { type: 'throw', from: 'D5', to: 'D2' });
    check('運ぶ: 投げられて動いたときは発動しない（既定）', pieceAt(tn0, 'E5').id === nb && tn0.stats.fires.carry === 0);
    const tn1 = reduce({ ...tc, rules: { ...tc.rules, carryWhenMoved: true } }, { type: 'throw', from: 'D5', to: 'D2' });
    check('運ぶ: carryWhenMoved=true なら投げられて動いたときも隣を連れていく（E5→E2）', pieceAt(tn1, 'E2') && pieceAt(tn1, 'E2').id === nb);
  }

  // --- 投げる ---
  {
    const thrower = (o, opts) => {
      let s = blank3(o, opts);
      const t = put(s, 'p1', 'bishopHurl', 'D4'); s = t.s;
      return { s: { ...s, active: 'p1' }, id: t.id };
    };
    // 空きマスへの着地（C5 の駒を、D4 を挟んだ反対側の2マス先 F2 へ）
    let b = thrower();
    let t = put(b.s, 'p1', 'pawn', 'C5'); let s = t.s; const pw = t.id;
    check('投げる: 合法手に出る（C5 → F2）', hasThrow(s, 'C5', 'F2') && throwerSquare(s, 'C5', 'F2') === 'D4');
    check('投げる(予測): 予測と実際の解決が一致する（空きマス）', sameAsThrowPreview(s, 'C5', 'F2'));
    let n = reduce(s, { type: 'throw', from: 'C5', to: 'F2' });
    check('投げる: 空きマスに着地する・投げる駒は動かない・1手として数える', pieceAt(n, 'F2').id === pw && !pieceAt(n, 'C5') && pieceAt(n, 'D4').id === b.id && n.ply === 1 && n.active === 'p2');
    check('投げる: 発動1回・投げた回数1', n.stats.fires.hurl === 1 && n.stats.throws === 1 && n.stats.throwBattles === 0);
    // 途中の駒を飛び越える（E3 に駒がいても F2 へ）
    t = put(s, 'p2', 'pawn', 'E3'); const s2 = t.s;
    check('投げる: 途中の駒（E3）は飛び越える', hasThrow(s2, 'C5', 'F2') && pieceAt(reduce(s2, { type: 'throw', from: 'C5', to: 'F2' }), 'F2').id === pw);
    // 敵への着地：勝ち
    b = thrower();
    t = put(b.s, 'p1', 'queenInspire', 'C5'); s = t.s; const qn = t.id;
    t = put(s, 'p2', 'pawn', 'F2'); s = t.s; const victim = t.id;
    check('投げる(予測): 予測と実際の解決が一致する（勝ち）', sameAsThrowPreview(s, 'C5', 'F2'));
    check('投げる: 勝敗の予想は投げられる前のマスの実際の強さで比べる', battleOutcome(s, 'C5', 'F2') === 'win');
    n = reduce(s, { type: 'throw', from: 'C5', to: 'F2' });
    check('投げる: 敵に着地したら投げられた駒が攻撃側で戦闘し、勝てばそのマスに入る', pieceAt(n, 'F2').id === qn && n.pieces[victim].controller === 'p1' && n.pending[0].type === 'placeDefector');
    check('投げる: 戦闘1回・勝ち1回', n.stats.throwBattles === 1 && n.stats.throwWins === 1 && n.stats.battles === 1);
    // 敵への着地：負け（投げられた駒は投げられる前のマスで倒れる）
    b = thrower();
    t = put(b.s, 'p1', 'pawn', 'C5'); s = t.s; const loser = t.id;
    t = put(s, 'p2', 'knightTraitor', 'F2'); s = t.s; const strong = t.id;
    check('投げる(予測): 予測と実際の解決が一致する（負け）', sameAsThrowPreview(s, 'C5', 'F2'));
    n = reduce(s, { type: 'throw', from: 'C5', to: 'F2' });
    check('投げる: 負けたら防御側はそのまま、投げられた駒は寝返る', pieceAt(n, 'F2').id === strong && !pieceAt(n, 'C5') && n.pieces[loser].controller === 'p2' && n.stats.throwWins === 0);
    check('投げる: 負けた駒が倒れたマスは投げられる前のマス（既定 thrownLoserFallsAt=origin・C5）', n.lastEvents.some((e) => e.type === 'defect' && e.pieceId === loser && e.at === 'C5'));
    const nl = reduce({ ...s, rules: { ...s.rules, thrownLoserFallsAt: 'landing' } }, { type: 'throw', from: 'C5', to: 'F2' });
    check('投げる: thrownLoserFallsAt=landing なら着地点（F2）で倒れたとして扱う', nl.lastEvents.some((e) => e.type === 'defect' && e.pieceId === loser && e.at === 'F2'));
    // 裏切り者を投げて負けたとき：倒れたマスの周りの元の味方が -1（既定は投げられる前のマスの周り）
    const tr = (o) => {
      let u = thrower(o);
      let v = put(u.s, 'p1', 'knightTraitor', 'C5'); u = v.s; const kt = v.id;
      v = put(u, 'p1', 'pawn', 'B6'); u = v.s; const nearOrigin = v.id;
      v = put(u, 'p1', 'pawn', 'G3'); u = v.s; const nearLanding = v.id;
      v = put(u, 'p2', 'queenInspire', 'F2'); u = v.s;
      const r = reduce(u, { type: 'throw', from: 'C5', to: 'F2' });
      return { o: r.pieces[nearOrigin].strength, l: r.pieces[nearLanding].strength, kt: r.pieces[kt].controller };
    };
    const t0 = tr();
    const t1 = tr({ thrownLoserFallsAt: 'landing' });
    check('投げる: 投げられて負けた裏切り者は、既定では投げられる前のマスの周り（B6）に効く', t0.kt === 'p2' && t0.o === 0 && t0.l === 1);
    check('投げる: thrownLoserFallsAt=landing なら着地点の周り（G3）に効く', t1.kt === 'p2' && t1.o === 1 && t1.l === 0);
    // 敵への着地：同値
    b = thrower();
    t = put(b.s, 'p1', 'pawn', 'C5'); s = t.s; const tie1 = t.id;
    t = put(s, 'p2', 'pawn', 'F2'); s = t.s; const tie2 = t.id;
    n = reduce(s, { type: 'throw', from: 'C5', to: 'F2' });
    check('投げる: 同値なら両方とも元の持ち主の山へ', !pieceAt(n, 'C5') && !pieceAt(n, 'F2') && n.players.p1.deck.includes(tie1) && n.players.p2.deck.includes(tie2) && n.stats.throwTies === 1);
    // 押し出しを持つ駒を投げて勝つ：押し出しの向きは投げた向き（C5→F2 の向き＝右下 → G1）
    b = thrower();
    t = put(b.s, 'p1', 'rookPush', 'C5'); s = t.s; const pr = t.id;
    t = put(s, 'p2', 'pawn', 'F2'); s = t.s;
    t = put(s, 'p2', 'pawn', 'G1'); s = t.s; const offp = t.id;
    check('投げる(予測): 予測と実際の解決が一致する（押し出しを持つ駒）', sameAsThrowPreview(s, 'C5', 'F2'));
    const pvp = previewThrow(filterStateFor(s, 'p1'), 'C5', 'F2');
    n = reduce(s, { type: 'throw', from: 'C5', to: 'F2' });
    check('投げる: 押し出しを持つ駒を投げて勝つと、投げた向き（F2 の先の G1）を押す', pieceAt(n, 'F2').id === pr && !pieceAt(n, 'G1') && n.players.p2.deck.includes(offp) && n.stats.fires.push === 1 && n.stats.pushOffBoard === 1);
    check('投げる: 予測にも押し出しの連鎖が出る', pvp.chain && pvp.chain.length === 1 && pvp.chain.offBoard === 1);
    // 味方の上・盤の外へは投げられない
    b = thrower();
    t = put(b.s, 'p1', 'pawn', 'C5'); s = t.s;
    t = put(s, 'p1', 'pawn', 'F2'); s = t.s;
    check('投げる: 着地点が味方の駒なら投げられない', !hasThrow(s, 'C5', 'F2') && throws(() => reduce(s, { type: 'throw', from: 'C5', to: 'F2' })));
    let e = blank3({}, { k1: 'G7' });
    t = put(e, 'p1', 'bishopHurl', 'B6'); e = t.s;
    t = put(e, 'p1', 'pawn', 'C5'); e = { ...t.s, active: 'p1' };
    check('投げる: 着地点が盤の外なら投げられない（C5 を B6 越しに投げると盤外）', !legalActions(e, 'p1').some((a) => a.type === 'throw' && a.from === 'C5'));
    // キング・不動は投げられない／敵の駒は投げられない
    b = thrower({}, { k1: 'C5' });
    t = put(b.s, 'p1', 'rookImmovable', 'E5'); s = t.s;
    t = put(s, 'p2', 'pawn', 'C3'); s = t.s;
    const th = legalActions(s, 'p1').filter((a) => a.type === 'throw');
    check('投げる: キング（C5）・不動（E5）・敵の駒（C3）は投げられない', th.length === 0);
    // キングに着地して勝てば決着（AI・view が使う kingFallsByAction も同じ答え）
    b = thrower({}, { k2: 'F2' });
    t = put(b.s, 'p1', 'queenInspire', 'C5'); s = t.s;
    check('投げる: キングに投げて倒せるなら kingFallsByAction が倒れる側を返す', kingFallsByAction(s, { type: 'throw', from: 'C5', to: 'F2' }) === 'p2');
    n = reduce(s, { type: 'throw', from: 'C5', to: 'F2' });
    check('投げる: キングに着地して勝てば決着', n.result && n.result.winner === 'p1');
    // 投げる駒が投げられた駒の向きの先にいないと投げにならない（throwerSquare の検査）
    check('投げる: 投げる駒の位置は from と to の間から決まる（間に投げる駒がいなければ null）', throwerSquare(s, 'C5', 'C2') === null);
  }

  // --- 前線基地 ---
  {
    // 先手のポーンが後手の最奥列（行1）にいる → その周囲8マスの空きマスが先手の置き場所に加わる
    let s = blank3();
    let t = put(s, 'p1', 'pawn', 'B1'); s = t.s; const fb = t.id;
    const hand = s.players.p1.hand.find((id) => s.pieces[id].kind === 'rookPush') || s.players.p1.hand[0];
    s = { ...s, active: 'p1', players: { ...s.players, p1: { ...s.players.p1, hand: s.players.p1.hand.includes(hand) ? s.players.p1.hand : [...s.players.p1.hand, hand] } } };
    check('前線基地: 成立（B1 の周囲の空きマス A1・C1・A2・B2・C2）', JSON.stringify(frontBaseSquares(s, 'p1')) === JSON.stringify(['A1', 'C1', 'A2', 'B2', 'C2']));
    const rook = s.players.p1.deck.concat(s.players.p1.hand).find((id) => s.pieces[id].kind === 'rookImmovable' && !s.cells.includes(id));
    let r = setPlayer(s, 'p1', { hand: [...s.players.p1.hand.filter((id) => id !== rook), rook], deck: s.players.p1.deck.filter((id) => id !== rook) });
    check('前線基地: 範囲0の駒（ルーク）も前線基地に置ける', placementSquares(r, 'p1', rook).includes('B2') && !basicPlacementSquares(r, 'p1', rook).includes('B2'));
    const placed = reduce(r, { type: 'place', pieceId: rook, to: 'B2' });
    check('前線基地: 置ける・前線基地に置いた回数が数えられる', pieceAt(placed, 'B2').id === rook && placed.stats.frontBasePlaces === 1 && placed.lastEvents[0].frontBase === true);
    check('前線基地: 相手（後手）の置き場所には加わらない', frontBaseSquares(s, 'p2').length === 0);
    // 倒されると消える（寝返る）
    t = put(s, 'p2', 'knightPhalanx', 'C3'); let k = { ...t.s, active: 'p2' };
    let kn = reduce(k, { type: 'move', from: 'C3', to: 'B1' });
    check('前線基地: そのポーンが倒される（寝返る）と、その場で消える', frontBaseSquares(kn, 'p1').length === 0 && kn.pieces[fb].controller === 'p2');
    // N 回目に倒されて山へ還るときも消える
    k = setPiece(k, fb, { defeats: 1 });
    kn = reduce(k, { type: 'move', from: 'C3', to: 'B1' });
    check('前線基地: N 回目に倒されて山へ還っても消える', frontBaseSquares(kn, 'p1').length === 0 && kn.players.p1.deck.includes(fb));
    // 寝返って相手のものになったポーン：後手の駒になった B1 のポーンは後手の自陣の最奥列なので基地にならない
    let d = blank3();
    t = put(d, 'p1', 'pawn', 'B1', 'p2'); d = t.s;
    check('前線基地: 寝返って相手のものになったポーンは、元の持ち主の基地にならない', frontBaseSquares(d, 'p1').length === 0 && frontBaseSquares(d, 'p2').length === 0);
    // 後手：先手の最奥列（行7）のポーン
    let q = blank3();
    t = put(q, 'p2', 'pawnTriumph', 'G7'); q = t.s;
    check('前線基地: 後手のポーンが行7にいると後手の置き場所に加わる（F6・G6・F7）', JSON.stringify(frontBaseSquares(q, 'p2')) === JSON.stringify(['F6', 'G6', 'F7']));
    // ポーン以外は基地にならない
    let w = blank3();
    t = put(w, 'p1', 'knightPhalanx', 'B1'); w = t.s;
    check('前線基地: ポーン以外の駒（ナイト）は基地にならない', frontBaseSquares(w, 'p1').length === 0);
    // フラグで切る
    const off = { ...s, rules: { ...s.rules, frontBase: false } };
    check('前線基地: フラグ（frontBase=false）で効かない', frontBaseSquares(off, 'p1').length === 0 && !placementSquares(off, 'p1', rook).includes('B2'));
    let z = blank3();
    t = put(z, 'p1', 'pawn', 'C1'); z = t.s;
    const zs = frontBaseSquares(z, 'p1');
    check('前線基地: 相手のキングの真横にも置ける（D1 のキングの隣の C2・D2 が加わる。キングのいる D1 は除く）', zs.includes('C2') && zs.includes('D2') && !zs.includes('D1'));
  }

  // --- 自動対戦：予測と実際の解決の一致・不変条件・視点フィルタ（モック3） ---
  {
    let mismatch = 0;
    let compared = 0;
    let throwCompared = 0;
    let total = true;
    let leaked = false;
    let legalSame = true;
    let fbSeen = 0;
    let fbPlaces = 0;
    const fired = {};
    for (const o of [{}, { winnerLosesStrength: true, kingStrength: 6 }]) {
      for (let seed = 2200; seed < 2240; seed++) {
        let s = createInitialState(seed, cardData, { ...M3, ...o });
        let r = createRng(seed);
        let seen = false;
        while (!s.result) {
          const who = decider(s);
          const acts = legalActions(s, who);
          // 投げる・攻撃・前へ出る手を優先して選ぶ（運ぶ・投げる・前線基地を起こしやすくする）。それ以外はランダム
          const d = nextRandom(r); r = d.rng;
          const throwsA = acts.filter((a) => a.type === 'throw');
          const attacks = acts.filter((a) => a.type === 'move' && pieceAt(s, a.to));
          const pushes = acts.filter((a) => a.type === 'move' && !pieceAt(s, a.to) && moveTypeOf(s, pieceAt(s, a.from)) === s.moveTypes[s.frontBase.moveType]);
          const pool = throwsA.length > 0 && d.value < 0.3 ? throwsA : attacks.length > 0 && d.value < 0.6 ? attacks : pushes.length > 0 && d.value < 0.85 ? pushes : acts;
          const a = pool[Math.floor(((d.value * 7919) % 1) * pool.length)];
          const v = filterStateFor(s, who);
          if (s.pending.length === 0) {
            if (legalActions(s, who).map(actionKey).join(',') !== legalActions(v, who).map(actionKey).join(',')) legalSame = false;
          }
          for (const viewer of PLAYERS) {
            const json = JSON.stringify(filterStateFor(s, viewer));
            const opp = opponentOf(viewer);
            for (const id of s.players[opp].hand) if (json.includes(`"${id}"`)) leaked = true;
            for (const pid of PLAYERS) for (const id of s.players[pid].deck) if (json.includes(`"${id}"`)) leaked = true;
            for (const p of s.pending) if (p.type === 'draft' && p.player !== viewer) for (const id of p.options) if (json.includes(`"${id}"`)) leaked = true;
          }
          const pv = a.type === 'move' || a.type === 'throw' ? previewAction(v, a) : null;
          s = reduce(s, a);
          if (pv) {
            compared++;
            if (a.type === 'throw') throwCompared++;
            const moveResult = s.result && s.result.reason !== 'maxPlies' ? s.result : null;
            if (JSON.stringify(pv.cells) !== JSON.stringify(s.cells) || JSON.stringify(pv.result) !== JSON.stringify(moveResult)) mismatch++;
          }
          if (!s.result && totalPieces(s) !== 34) total = false;
          if (!seen && PLAYERS.some((pid) => frontBaseSquares(s, pid).length > 0)) seen = true;
        }
        if (seen) fbSeen++;
        fbPlaces += s.stats.frontBasePlaces;
        for (const k of Object.keys(s.stats.fires)) fired[k] = (fired[k] || 0) + s.stats.fires[k];
      }
    }
    console.log(`  （参考）モック3 80局：予測と比べた手 ${compared} 回（うち投げる ${throwCompared}）・前線基地が成立した試合 ${fbSeen}・前線基地に置いた回数 ${fbPlaces}・発動 ${JSON.stringify(fired)}`);
    check('予測(モック3): 自動対戦の全ての移動・投げるで、予測（フィルタ済みの state）と実際の解決の盤・決着が一致する', compared > 0 && throwCompared > 0 && mismatch === 0);
    check('能力(モック3): 自動対戦で運ぶ・投げるが実際に起きている（検査が空振りしていない）', fired.carry > 0 && fired.hurl > 0);
    check('前線基地(モック3): 自動対戦で前線基地が成立し、そこに置く手が実際に指されている', fbSeen > 0 && fbPlaces > 0);
    check('不変条件(モック3): 駒の総数は常に34', total);
    check('フィルタ(モック3): 相手の手札・両者の山・相手のドラフトの2枚が含まれない', !leaked);
    check('フィルタ(モック3): フィルタ後の state でも本人の合法手は同じ（投げるを含む）', legalSame);
  }

  // =========================================================================
  // モック4（CG-025）：運ぶ（改）・入れ替え・すり抜け・反動・爆風・道連れ／発火点「動かされたとき」ほか
  // =========================================================================
  const M4 = { pieceSet: 'mock4', frontBase: true };
  const blank4 = (overrides, opts) => blank({ ...M4, ...overrides }, opts);
  /** 手番の行動（move・throw・swap）の予測（フィルタ済みの state で previewAction）と実際の解決の盤・決着が一致するか */
  const sameAsActionPreview = (s, a) => {
    const pv = previewAction(filterStateFor(s, s.active), a);
    const n = reduce(s, a);
    return JSON.stringify(pv.cells) === JSON.stringify(n.cells) && JSON.stringify(pv.result && { ...pv.result }) === JSON.stringify(n.result && { ...n.result });
  };
  const legalHas = (s, a) => legalActions(s, s.active).some((x) => actionKey(x) === actionKey(a));
  const evs = (n, type) => n.lastEvents.filter((e) => e.type === type);
  const maxDepthOf = (n) => Math.max(0, ...n.lastEvents.map((e) => e.depth || 0));

  // --- 運ぶ（改） ---
  {
    // 候補が2体：持ち主が選ぶ（候補の順番 → 運ばない）。候補の順番は持ち主から見た読み順（先手は前の列から・左から）
    let s = blank4();
    let t = put(s, 'p1', 'pawnCarryAny', 'C5'); s = t.s; const car = t.id;
    t = put(s, 'p1', 'pawn', 'D5'); s = t.s; const a1 = t.id;
    t = put(s, 'p1', 'pawnTriumph', 'B6'); s = t.s; const a2 = t.id;
    s = { ...s, active: 'p1' };
    check('運ぶ(改): 候補が2体なら選択肢は 候補の順番（D5→B6）＋運ばない', JSON.stringify(carryOptions(s, 'C5', 'C4')) === JSON.stringify(['D5', 'B6', null]));
    check('運ぶ(改): 合法手に carry 違いの3つが並び、carry なしの手は合法ではない', legalHas(s, { type: 'move', from: 'C5', to: 'C4', carry: 'D5' }) && legalHas(s, { type: 'move', from: 'C5', to: 'C4', carry: 'B6' }) && legalHas(s, { type: 'move', from: 'C5', to: 'C4', carry: null }) && !legalHas(s, { type: 'move', from: 'C5', to: 'C4' }) && throws(() => reduce(s, { type: 'move', from: 'C5', to: 'C4' })));
    let n = reduce(s, { type: 'move', from: 'C5', to: 'C4', carry: 'B6' });
    check('運ぶ(改): 選んだ駒（B6）が同じ向きに同じだけ動き、もう1体（D5）は動かない', pieceAt(n, 'C4').id === car && pieceAt(n, 'B5').id === a2 && pieceAt(n, 'D5').id === a1 && n.stats.fires.carryAny === 1 && n.stats.carried === 1);
    check('運ぶ(改): 運ばれた駒は1段目（イベントの depth）', evs(n, 'carried')[0].depth === 1 && maxDepthOf(n) === 1);
    n = reduce(s, { type: 'move', from: 'C5', to: 'C4', carry: null });
    check('運ぶ(改): 運ばない（null）を選べる（発動に数えない）', pieceAt(n, 'D5').id === a1 && pieceAt(n, 'B6').id === a2 && n.stats.fires.carryAny === 0);
    check('運ぶ(改)(予測): 選択ごとに予測と実際の解決が一致する', [null, 'D5', 'B6'].every((c) => sameAsActionPreview(s, { type: 'move', from: 'C5', to: 'C4', carry: c })));
    // 候補が1体：自動（運ばないは選べない）。rules.carryDeclineSingle なら運ばないも選べる
    s = blank4();
    t = put(s, 'p1', 'pawnCarryAny', 'C5'); s = t.s;
    t = put(s, 'p1', 'pawn', 'D5'); s = { ...t.s, active: 'p1' };
    check('運ぶ(改): 候補が1体なら自動（選択肢はその1体だけ）', JSON.stringify(carryOptions(s, 'C5', 'C4')) === JSON.stringify(['D5']));
    check('運ぶ(改): carryDeclineSingle=true なら候補が1体でも運ばないを選べる', JSON.stringify(carryOptions({ ...s, rules: { ...s.rules, carryDeclineSingle: true } }, 'C5', 'C4')) === JSON.stringify(['D5', null]));
    // 攻撃：勝ち（威圧で相手のポーンが 0）→ 勝ってマスに入った後に運ぶ
    const attackSetup = (enemyKind, withQueen) => {
      let u = blank4();
      let v = put(u, 'p1', 'pawnCarryAny', 'C5'); u = v.s; const c = v.id;
      v = put(u, 'p1', 'pawn', 'D5'); u = v.s; const comp = v.id;
      v = put(u, 'p2', enemyKind, 'B4'); u = v.s; const enemy = v.id;
      if (withQueen) { v = put(u, 'p1', 'queenIntimidate', 'A5'); u = v.s; }
      return { s: { ...u, active: 'p1' }, c, comp, enemy };
    };
    let w = attackSetup('pawn', true);
    check('運ぶ(改)・攻撃(勝ち): 勝てる攻撃にも carry の選択肢が付く（D5）', battleOutcome(w.s, 'C5', 'B4') === 'win' && JSON.stringify(carryOptions(w.s, 'C5', 'B4')) === JSON.stringify(['D5']));
    n = reduce(w.s, { type: 'move', from: 'C5', to: 'B4', carry: 'D5' });
    const order = n.lastEvents.map((e) => e.type);
    check('運ぶ(改)・攻撃(勝ち): 勝ってマスに入った後、隣の味方が同じ向き（斜め）に動く（D5→C4）', pieceAt(n, 'B4').id === w.c && pieceAt(n, 'C4').id === w.comp && !pieceAt(n, 'D5') && order.indexOf('battle') < order.indexOf('carried'));
    check('運ぶ(改)・攻撃(勝ち)(予測): 予測と実際の解決が一致する', sameAsActionPreview(w.s, { type: 'move', from: 'C5', to: 'B4', carry: 'D5' }));
    w = attackSetup('knightTraitor', true);
    check('運ぶ(改)・攻撃(負け): 負ける攻撃には選択肢が付かない', battleOutcome(w.s, 'C5', 'B4') === 'lose' && carryOptions(w.s, 'C5', 'B4') === null && legalHas(w.s, { type: 'move', from: 'C5', to: 'B4' }));
    n = reduce(w.s, { type: 'move', from: 'C5', to: 'B4' });
    check('運ぶ(改)・攻撃(負け): 負けたら運ばない（D5 は動かない・発動なし）', pieceAt(n, 'D5').id === w.comp && n.stats.fires.carryAny === 0 && n.pieces[w.c].controller === 'p2');
    w = attackSetup('pawn', false);
    check('運ぶ(改)・攻撃(同値): 同値の攻撃には選択肢が付かない', battleOutcome(w.s, 'C5', 'B4') === 'tie' && carryOptions(w.s, 'C5', 'B4') === null);
    n = reduce(w.s, { type: 'move', from: 'C5', to: 'B4' });
    check('運ぶ(改)・攻撃(同値): 同値なら両方山へ還り、運ばない', !pieceAt(n, 'C5') && !pieceAt(n, 'B4') && pieceAt(n, 'D5').id === w.comp && n.stats.fires.carryAny === 0);
    // キングは運ばない・不動は運ぶ（モック3の仮決め5と同じ）・運ばれた駒の運ぶ（改）は連鎖しない
    s = blank4();
    t = put(s, 'p1', 'pawnCarryAny', 'C6'); s = { ...t.s, active: 'p1' };
    check('運ぶ(改): キング（隣の D7）は候補にならない', carryOptions(s, 'C6', 'C5') === null);
    s = blank4();
    t = put(s, 'p1', 'pawnCarryAny', 'C5'); s = t.s;
    t = put(s, 'p1', 'pawnImmovable', 'D5'); s = { ...t.s, active: 'p1' };
    check('運ぶ(改): 不動の駒は運べる', JSON.stringify(carryOptions(s, 'C5', 'C4')) === JSON.stringify(['D5']));
    s = blank4();
    t = put(s, 'p1', 'pawnCarryAny', 'C5'); s = t.s;
    t = put(s, 'p1', 'pawnCarryAny', 'D5'); s = t.s; const mid = t.id;
    t = put(s, 'p1', 'pawn', 'E5'); s = { ...t.s, active: 'p1' }; const far = t.id;
    n = reduce(s, { type: 'move', from: 'C5', to: 'C4', carry: 'D5' });
    check('運ぶ(改): 運ばれた駒の運ぶ（改）は連鎖しない（D5→D4、E5 は動かない）', pieceAt(n, 'D4').id === mid && pieceAt(n, 'E5').id === far && n.stats.fires.carryAny === 1);
    // 行き先が空いていない駒は候補にならない
    s = blank4();
    t = put(s, 'p1', 'pawnCarryAny', 'C5'); s = t.s;
    t = put(s, 'p1', 'pawn', 'D5'); s = t.s;
    t = put(s, 'p2', 'pawn', 'D4'); s = { ...t.s, active: 'p1' };
    check('運ぶ(改): 行き先（D4）に駒がいる駒は候補にならない（選択肢なし）', carryOptions(s, 'C5', 'C4') === null);
    // 押されて動いた運ぶ（改）：既定は運ばない／rules.carryWhenMoved なら決め打ちの順番の先頭を運ぶ（モック3の運ぶと同じフラグ）
    let pm = blank4({}, { k1: 'A7', k2: 'G1' });
    t = put(pm, 'p1', 'rookPush', 'D7'); pm = t.s;
    t = put(pm, 'p2', 'pawn', 'D6'); pm = t.s;
    t = put(pm, 'p1', 'pawnCarryAny', 'D5'); pm = t.s; const pc = t.id;
    t = put(pm, 'p1', 'pawn', 'E5'); pm = { ...t.s, active: 'p1' }; const pe = t.id;
    n = reduce(pm, { type: 'move', from: 'D7', to: 'D6' });
    check('運ぶ(改): 押されて動いたときは既定では運ばない（carryWhenMoved=false）', pieceAt(n, 'D4').id === pc && pieceAt(n, 'E5').id === pe && n.stats.fires.carryAny === 0);
    const pmw = { ...pm, rules: { ...pm.rules, carryWhenMoved: true } };
    n = reduce(pmw, { type: 'move', from: 'D7', to: 'D6' });
    check('運ぶ(改): carryWhenMoved=true なら押されて動いたときも決め打ちの順番の先頭（E5）を運ぶ（E5→E4）', pieceAt(n, 'D4').id === pc && pieceAt(n, 'E4') && pieceAt(n, 'E4').id === pe && n.stats.fires.carryAny === 1);
    check('運ぶ(改)(予測): carryWhenMoved=true でも予測と実際の解決が一致する', sameAsActionPreview(pmw, { type: 'move', from: 'D7', to: 'D6' }));
    // モック3の運ぶ（右隣・攻撃では発動しない）はモック3の駒構成でそのまま（上の「運ぶ」の検査）
    check('運ぶ: モック3の運ぶとモック4の運ぶ（改）は別の能力定義', cardData.abilities.carry.trigger === 'onMove' && cardData.abilities.carryAny.trigger === 'onSelfMove' && cardData.pieceSets.mock3.list.some((d) => d.ability === 'carry') && !cardData.pieceSets.mock4.list.some((d) => d.ability === 'carry'));
  }

  // --- すり抜け ---
  {
    const slip = (pieces) => {
      let s = blank4();
      let t = put(s, 'p1', 'bishopSlip', 'C5'); s = t.s;
      for (const [owner, kind, sq] of pieces) { t = put(s, owner, kind, sq); s = t.s; }
      return { ...s, active: 'p1' };
    };
    let s = slip([['p1', 'pawn', 'D4']]);
    check('すり抜け: 味方1体（D4）を飛び越えて E3・F2・G1 へ動ける（D4 には止まれない）', ['E3', 'F2', 'G1'].every((q) => tos(s, 'C5').includes(q)) && !tos(s, 'C5').includes('D4'));
    s = slip([['p1', 'pawn', 'D4'], ['p1', 'pawnTriumph', 'E3']]);
    check('すり抜け: 味方2体（D4・E3）は飛び越えられない', !['D4', 'E3', 'F2', 'G1'].some((q) => tos(s, 'C5').includes(q)));
    s = slip([['p2', 'pawn', 'D4']]);
    check('すり抜け: 敵（D4）は飛び越えられない（取るだけ）', tos(s, 'C5').includes('D4') && !tos(s, 'C5').includes('E3'));
    s = slip([['p1', 'pawn', 'D4'], ['p2', 'pawn', 'F2']]);
    check('すり抜け: 味方を飛び越えた先の敵は取れる（F2・その先の G1 へは行けない）', tos(s, 'C5').includes('E3') && tos(s, 'C5').includes('F2') && !tos(s, 'C5').includes('G1'));
    s = slip([['p1', 'pawn', 'D4']]);
    const n = reduce(s, { type: 'move', from: 'C5', to: 'F2' });
    check('すり抜け: 飛び越えた移動で発動に数える（飛び越えた駒をイベントに出す）', pieceAt(n, 'F2') && n.stats.fires.slip === 1 && n.stats.allyPasses === 1 && evs(n, 'passed')[0].at === 'D4');
    const n2 = reduce(s, { type: 'move', from: 'C5', to: 'B4' });
    check('すり抜け: 飛び越えない移動は発動に数えない', n2.stats.fires.slip === 0);
    let h = blank4();
    let t = put(h, 'p1', 'bishopHurl', 'C5'); h = t.s;
    t = put(h, 'p1', 'pawn', 'D4'); h = t.s;
    check('すり抜け: すり抜けを持たない駒（投げるのビショップ）は飛び越えられない', !tos(h, 'C5').includes('E3'));
  }

  // --- 反動 ---
  {
    const line = (lastKind, lastOwner, k2) => {
      let s = blank4({}, { k1: 'A7', k2: k2 || 'G1' });
      let t = put(s, 'p1', 'rookPush', 'D7'); s = t.s;
      t = put(s, 'p2', 'pawnTriumph', 'D6'); s = t.s;
      t = put(s, 'p1', 'pawnRecoil', 'D5'); s = t.s; const r1 = t.id;
      t = put(s, 'p2', 'pawnRecoil', 'D3'); s = t.s; const r2 = t.id;
      let x = null;
      if (lastKind) { t = put(s, lastOwner, lastKind, 'D1'); s = t.s; x = t.id; }
      return { s: { ...s, active: 'p1' }, r1, r2, x };
    };
    let L = line('pawn', 'p2');
    let n = reduce(L.s, { type: 'move', from: 'D7', to: 'D6' });
    check('反動: 押されて止まった先で同じ向きのもう1つ先を押す（D5→D4、反動で D3→D2）', pieceAt(n, 'D4').id === L.r1 && pieceAt(n, 'D2').id === L.r2);
    check('反動: 反動の連鎖（D2 の反動で D1 の駒が盤の外へ・元の持ち主の山へ）', !pieceAt(n, 'D1') && n.players.p2.deck.includes(L.x) && n.stats.fires.recoil === 2 && n.stats.pushOffBoard === 1);
    const ds = evs(n, 'pushed').map((e) => e.depth);
    check('反動: 段は 押し出し1 → 反動2 → 反動3', JSON.stringify(ds) === JSON.stringify([1, 2, 3]) && maxDepthOf(n) === 3);
    check('反動(予測): 予測と実際の解決が一致する・予測にも3段目まで出る', sameAsActionPreview(L.s, { type: 'move', from: 'D7', to: 'D6' }) && previewMove(filterStateFor(L.s, 'p1'), 'D7', 'D6').maxDepth === 3);
    L = line(null, null, 'D1');
    n = reduce(L.s, { type: 'move', from: 'D7', to: 'D6' });
    check('反動: キングは押さない（D1 のキングで止まる）', pieceAt(n, 'D1').id === 'p2-K' && pieceAt(n, 'D2').id === L.r2 && evs(n, 'pushStop').some((e) => e.why === 'king' && e.at === 'D1'));
    L = line('pawnImmovable', 'p2');
    n = reduce(L.s, { type: 'move', from: 'D7', to: 'D6' });
    check('反動: 不動は押さない（D1 で止まる）', pieceAt(n, 'D1').id === L.x && evs(n, 'pushStop').some((e) => e.why === 'blocked' && e.at === 'D1'));
    // 押されて盤の外へ出た反動の駒は発動しない（盤上で止まっていない）
    let o = blank4({}, { k1: 'A7', k2: 'G1' });
    let t = put(o, 'p1', 'rookPush', 'D4'); o = t.s;
    t = put(o, 'p2', 'pawn', 'D2'); o = t.s;
    t = put(o, 'p2', 'pawnRecoil', 'D1'); o = { ...t.s, active: 'p1' };
    n = reduce(o, { type: 'move', from: 'D4', to: 'D2' });
    check('反動: 盤の外へ押し出された反動の駒は発動しない', n.stats.pushOffBoard === 1 && n.stats.fires.recoil === 0);
    // 押されて戦闘になり、勝ってそのマスに止まった反動の駒は発動する
    let b = blank4({}, { k1: 'A7', k2: 'G1' });
    t = put(b, 'p1', 'rookPush', 'D7'); b = t.s;
    t = put(b, 'p2', 'pawn', 'D6'); b = t.s;
    t = put(b, 'p1', 'pawnRecoil', 'D5'); b = t.s; const rb = t.id;
    t = put(b, 'p2', 'pawnTriumph', 'D4'); b = t.s;
    t = put(b, 'p1', 'queenIntimidate', 'C3'); b = t.s;   // D4 の敵は威圧で 0 → 反動のポーン（1）が勝つ
    t = put(b, 'p2', 'pawnCarryAny', 'D3'); b = { ...t.s, active: 'p1' }; const behind = t.id;
    n = reduce(b, { type: 'move', from: 'D7', to: 'D6' });
    check('反動: 押されて戦闘に勝ち、そのマスに止まったときも発動する（D4 に入り、反動で D3→D2）', pieceAt(n, 'D4').id === rb && pieceAt(n, 'D2') && pieceAt(n, 'D2').id === behind && n.stats.fires.recoil === 1);
  }

  // --- 爆風 ---
  {
    // D5 の爆風のナイトを D4 の投げるのビショップ越しに D2 へ投げる。D2 の周り（先手の読み順 C1・D1・E1・C2・E2・C3・D3・E3）
    const setup = (extra, opts) => {
      let s = blank4({}, opts || { k1: 'A7', k2: 'E1' });
      let t = put(s, 'p1', 'bishopHurl', 'D4'); s = t.s;
      t = put(s, 'p1', 'knightBlast', 'D5'); s = t.s; const bl = t.id;
      const ids = {};
      for (const [name, owner, kind, sq] of extra) { t = put(s, owner, kind, sq); s = t.s; ids[name] = t.id; }
      return { s: { ...s, active: 'p1' }, bl, ids };
    };
    const S = setup([
      ['off', 'p2', 'pawn', 'C1'], ['imm', 'p2', 'pawnImmovable', 'D1'],
      ['tr', 'p2', 'knightTraitor', 'C2'], ['mine', 'p1', 'pawn', 'B2'],
      ['rc', 'p1', 'pawnRecoil', 'E2'], ['far', 'p2', 'pawnTriumph', 'G2'],
    ]);
    const A = { type: 'throw', from: 'D5', to: 'D2' };
    check('爆風: 合法手に出る（D5 を D4 越しに D2 へ）', legalHas(S.s, A));
    const n = reduce(S.s, A);
    const seq = n.lastEvents.filter((e) => (e.type === 'pushed' || e.type === 'pushStop') && e.depth !== undefined || (e.type === 'pushStop' && e.at)).filter((e) => e.type === 'pushed' || ['blocked', 'king'].includes(e.why)).map((e) => e.from || e.at);
    check('爆風: 押す順番は先手から見た読み順（C1・D1(不動)・E1(キング)・C2・E2、反動で G2）', JSON.stringify(seq) === JSON.stringify(['C1', 'D1', 'E1', 'C2', 'E2', 'G2']));
    check('爆風: 盤の外（C1→B0）へ押された駒は元の持ち主の山へ', !pieceAt(n, 'C1') && n.players.p2.deck.includes(S.ids.off));
    check('爆風: 不動（D1）・キング（E1）は押されない', pieceAt(n, 'D1').id === S.ids.imm && pieceAt(n, 'E1').id === 'p2-K');
    check('爆風: 衝突（C2→B2 に味方がいる）は押された駒を攻撃側として戦闘（3 対 1 で勝って B2 に入る）', pieceAt(n, 'B2').id === S.ids.tr && n.pieces[S.ids.mine].controller === 'p2');
    check('爆風: 押された反動の駒（E2→F2）がさらに押す（G2→盤の外）', pieceAt(n, 'F2').id === S.ids.rc && !pieceAt(n, 'G2') && n.stats.fires.recoil === 1);
    check('爆風: 発動1回・盤の外へ押し出し2回・段は 投げる1 → 爆風2 → 反動3', n.stats.fires.blast === 1 && n.stats.pushOffBoard === 2 && evs(n, 'throw')[0].depth === 1 && maxDepthOf(n) === 3);
    check('爆風(予測): 予測と実際の解決が一致する', sameAsActionPreview(S.s, A));
    check('爆風: 後手の読み順は逆（D4 の周りは E5 から）', areaInReadingOrder(S.s, 'around8', 'D4', 'p2')[0] === 'E5' && areaInReadingOrder(S.s, 'around8', 'D4', 'p1')[0] === 'C3');
    // 敵に着地して勝てば、そのマスに入った後に爆風。負ければ爆風は起きない
    let W = setup([['vic', 'p2', 'pawn', 'D2'], ['nb', 'p2', 'pawnTriumph', 'E2']]);
    let m = reduce(W.s, A);
    check('爆風: 敵に着地して勝ったら、入った後に周りを押す（E2→F2）', pieceAt(m, 'D2').id === W.bl && pieceAt(m, 'F2') && pieceAt(m, 'F2').id === W.ids.nb && m.stats.fires.blast === 1);
    W = setup([['vic', 'p2', 'knightTraitor', 'D2'], ['nb', 'p2', 'pawn', 'E2']]);
    m = reduce(W.s, A);
    check('爆風: 敵に着地して負けたら起きない', m.stats.fires.blast === 0 && pieceAt(m, 'E2').id === W.ids.nb);
    // 爆風で押した駒がキングに当たって勝てば決着（空きマスへの着地でもキングが倒れうる：kingFallsByAction が読む）
    const K = setup([['q', 'p1', 'queenIntimidate', 'E2']], { k1: 'A7', k2: 'F2' });
    check('爆風: 空きマスへの投げでも、押した先でキングが倒れるなら kingFallsByAction が倒れる側を返す', kingFallsByAction(K.s, A) === 'p2');
    m = reduce(K.s, A);
    check('爆風: 押されたクイーン（4）がキング（3−威圧1）に勝って決着', m.result && m.result.winner === 'p1');
  }

  // --- 道連れ ---
  {
    // 運ぶ（改）で動かされた道連れのナイト（D5→D4）が、後ろ（D6）の敵を同じ向きに同じだけ引きずる（D6→D5）
    const carrySetup = (behind, opts) => {
      let s = blank4({}, opts || { k1: 'A7', k2: 'G1' });
      let t = put(s, 'p1', 'pawnCarryAny', 'C5'); s = t.s;
      t = put(s, 'p1', 'knightDrag', 'D5'); s = t.s; const kd = t.id;
      let b = null;
      if (behind) { t = put(s, behind[0], behind[1], 'D6'); s = t.s; b = t.id; }
      return { s: { ...s, active: 'p1' }, kd, b };
    };
    const A = { type: 'move', from: 'C5', to: 'C4', carry: 'D5' };
    let C = carrySetup(['p2', 'pawn']);
    let n = reduce(C.s, A);
    check('道連れ: 後ろに敵がいる → 同じ向きに同じだけ引きずる（D6→D5）', pieceAt(n, 'D4').id === C.kd && pieceAt(n, 'D5').id === C.b && !pieceAt(n, 'D6') && n.stats.fires.drag === 1 && n.stats.dragged === 1);
    check('道連れ: 段は 運ぶ1 → 道連れ2', evs(n, 'dragged')[0].depth === 2 && maxDepthOf(n) === 2);
    check('道連れ(予測): 予測と実際の解決が一致する', sameAsActionPreview(C.s, A));
    C = carrySetup(null);
    n = reduce(C.s, A);
    check('道連れ: 後ろに敵がいない → 何も起きない（発動に数えない）', n.stats.fires.drag === 0 && n.stats.dragged === 0);
    C = carrySetup(['p1', 'pawn']);
    n = reduce(C.s, A);
    check('道連れ: 後ろが味方なら引きずらない', pieceAt(n, 'D6').id === C.b && n.stats.fires.drag === 0);
    C = carrySetup(null, { k1: 'A7', k2: 'D6' });
    n = reduce(C.s, A);
    check('道連れ: 後ろの敵がキングなら引きずらない（発動はする）', pieceAt(n, 'D6').id === 'p2-K' && n.stats.fires.drag === 1 && evs(n, 'dragBlocked')[0].why === 'king');
    C = carrySetup(['p2', 'pawnImmovable']);
    n = reduce(C.s, A);
    check('道連れ: 後ろの敵が不動なら引きずらない', pieceAt(n, 'D6').id === C.b && evs(n, 'dragBlocked')[0].why === 'blocked');
    // 道連れの連鎖：引きずられた敵も道連れなら、その後ろ（D7）の敵（先手のポーン）を引きずる → 3段目
    let s = blank4({}, { k1: 'A7', k2: 'G1' });
    let t = put(s, 'p1', 'pawnCarryAny', 'C5'); s = t.s;
    t = put(s, 'p1', 'knightDrag', 'D5'); s = t.s;
    t = put(s, 'p2', 'knightDrag', 'D6'); s = t.s; const e2 = t.id;
    t = put(s, 'p1', 'pawn', 'D7'); s = { ...t.s, active: 'p1' }; const back = t.id;
    n = reduce(s, A);
    check('道連れ: 連鎖（引きずられた道連れが後ろの敵を引きずる：D6→D5、D7→D6）・3段', pieceAt(n, 'D5').id === e2 && pieceAt(n, 'D6').id === back && n.stats.fires.drag === 2 && maxDepthOf(n) === 3);
    check('道連れ(予測): 連鎖でも予測と実際の解決が一致する', sameAsActionPreview(s, A));
    // 打ち切り：後ろの敵がこの連鎖ですでに動いた駒（爆風で押された道連れのナイトの後ろは、投げられた爆風のナイト）
    let x = blank4({}, { k1: 'A7', k2: 'G1' });
    t = put(x, 'p1', 'bishopHurl', 'D4'); x = t.s;
    t = put(x, 'p1', 'knightBlast', 'D5'); x = t.s; const blast = t.id;
    t = put(x, 'p2', 'knightDrag', 'E2'); x = { ...t.s, active: 'p1' }; const kd2 = t.id;
    n = reduce(x, { type: 'throw', from: 'D5', to: 'D2' });
    check('道連れ: 打ち切り（後ろの敵＝投げられた爆風の駒はこの連鎖で動いたので引きずらない）', pieceAt(n, 'F2').id === kd2 && pieceAt(n, 'D2').id === blast && evs(n, 'dragBlocked')[0].why === 'alreadyMoved');
  }

  // --- 入れ替え ---
  {
    let s = blank4({}, { k1: 'E6', k2: 'G1' });
    let t = put(s, 'p1', 'rookExchange', 'D5'); s = t.s; const rk = t.id;
    t = put(s, 'p1', 'pawn', 'C5'); s = t.s; const pw = t.id;
    t = put(s, 'p1', 'pawnImmovable', 'E4'); s = t.s;
    t = put(s, 'p2', 'pawn', 'D4'); s = { ...t.s, active: 'p1' };
    const sw = legalActions(s, 'p1').filter((a) => a.type === 'swap').map((a) => `${a.from}-${a.to}`).sort();
    check('入れ替え: 合法手に隣の味方との交換が出る（キング E6・敵 D4 とは交換できない。不動 E4 とはできる）', JSON.stringify(sw) === JSON.stringify(['D5-C5', 'D5-E4']));
    check('入れ替え: 移動の後・置くの前に並ぶ', (() => { const l = legalActions(s, 'p1'); const i = l.findIndex((a) => a.type === 'swap'); return l.slice(0, i).every((a) => a.type === 'move') && l.slice(i).every((a) => a.type === 'swap' || a.type === 'place' || a.type === 'throw'); })());
    const n = reduce(s, { type: 'swap', from: 'D5', to: 'C5' });
    check('入れ替え: 位置を交換する・1手として数える・発動1回', pieceAt(n, 'C5').id === rk && pieceAt(n, 'D5').id === pw && n.ply === 1 && n.active === 'p2' && n.stats.fires.exchange === 1 && n.stats.swaps === 1);
    check('入れ替え(予測): 予測と実際の解決が一致する', sameAsActionPreview(s, { type: 'swap', from: 'D5', to: 'C5' }));
    check('入れ替え: actionSource は入れ替える駒のマス', actionSource(s, { type: 'swap', from: 'D5', to: 'C5' }) === 'D5');
    // 交換された相手は「動かされた」：道連れのナイトと交換すると道連れが発動する（行き先は入れ替えた駒がいるので既定は引きずらない）
    let d = blank4({}, { k1: 'A7', k2: 'G1' });
    t = put(d, 'p1', 'rookExchange', 'E5'); d = t.s; const rx = t.id;
    t = put(d, 'p1', 'knightDrag', 'D5'); d = t.s; const kn = t.id;
    t = put(d, 'p2', 'pawn', 'C5'); d = { ...t.s, active: 'p1' }; const en = t.id;
    let m = reduce(d, { type: 'swap', from: 'E5', to: 'D5' });
    check('入れ替え: 交換された相手（道連れ）の【動かされたとき】が発動する（1段目の相手が2段目を起こす）', pieceAt(m, 'E5').id === kn && pieceAt(m, 'D5').id === rx && m.stats.fires.drag === 1 && evs(m, 'swap')[0].depth === 1);
    check('入れ替え: 道連れの行き先（D5）は入れ替えた駒がいるので、既定（dragBlocked=stay）では引きずらない', pieceAt(m, 'C5').id === en && evs(m, 'dragBlocked')[0].why === 'occupied');
    const db = { ...d, rules: { ...d.rules, dragBlocked: 'battle' } };
    m = reduce(db, { type: 'swap', from: 'E5', to: 'D5' });
    check('入れ替え: dragBlocked=battle なら、引きずられた敵（C5）が攻撃側で D5 の駒と戦闘する', evs(m, 'battle').some((e) => e.from === 'C5' && e.to === 'D5') && pieceAt(m, 'D5').id === rx && !pieceAt(m, 'C5'));
    check('入れ替え(予測): dragBlocked=battle でも予測と実際の解決が一致する', sameAsActionPreview(db, { type: 'swap', from: 'E5', to: 'D5' }));
  }

  // --- 自動対戦：予測と実際の解決の一致・不変条件・視点フィルタ（モック4） ---
  {
    let mismatch = 0;
    let compared = 0;
    const byType = { move: 0, throw: 0, swap: 0, carry: 0 };
    let total = true;
    let leaked = false;
    let legalSame = true;
    let deep = 0;
    let choiceOffered = 0;
    const fired = {};
    for (const o of [{}, { winnerLosesStrength: true, kingStrength: 6 }]) {
      for (let seed = 2400; seed < 2440; seed++) {
        let s = createInitialState(seed, cardData, { ...M4, ...o });
        let r = createRng(seed);
        while (!s.result) {
          const who = decider(s);
          const acts = legalActions(s, who);
          // 投げる・入れ替え・攻撃・運ぶ（改）の選択がある移動を優先して選ぶ（新しい能力を起こしやすくする）。それ以外はランダム
          const d = nextRandom(r); r = d.rng;
          const throwsA = acts.filter((a) => a.type === 'throw');
          const swapsA = acts.filter((a) => a.type === 'swap');
          const attacks = acts.filter((a) => a.type === 'move' && pieceAt(s, a.to));
          const carries = acts.filter((a) => a.type === 'move' && a.carry !== undefined);
          const pool = throwsA.length > 0 && d.value < 0.3 ? throwsA : swapsA.length > 0 && d.value < 0.4 ? swapsA : carries.length > 0 && d.value < 0.55 ? carries : attacks.length > 0 && d.value < 0.75 ? attacks : acts;
          const a = pool[Math.floor(((d.value * 7919) % 1) * pool.length)];
          if (a.type === 'move' && acts.filter((x) => x.type === 'move' && x.from === a.from && x.to === a.to).length >= 3) choiceOffered++;
          const v = filterStateFor(s, who);
          if (s.pending.length === 0) {
            if (legalActions(s, who).map(actionKey).join(',') !== legalActions(v, who).map(actionKey).join(',')) legalSame = false;
          }
          for (const viewer of PLAYERS) {
            const json = JSON.stringify(filterStateFor(s, viewer));
            const opp = opponentOf(viewer);
            for (const id of s.players[opp].hand) if (json.includes(`"${id}"`)) leaked = true;
            for (const pid of PLAYERS) for (const id of s.players[pid].deck) if (json.includes(`"${id}"`)) leaked = true;
            for (const p of s.pending) if (p.type === 'draft' && p.player !== viewer) for (const id of p.options) if (json.includes(`"${id}"`)) leaked = true;
          }
          const pv = a.type === 'move' || a.type === 'throw' || a.type === 'swap' ? previewAction(v, a) : null;
          s = reduce(s, a);
          if (pv) {
            compared++;
            byType[a.type]++;
            if (a.carry !== undefined) byType.carry++;
            const moveResult = s.result && s.result.reason !== 'maxPlies' ? s.result : null;
            if (JSON.stringify(pv.cells) !== JSON.stringify(s.cells) || JSON.stringify(pv.result) !== JSON.stringify(moveResult)) mismatch++;
            if (pv.maxDepth >= 2) deep++;
          }
          if (!s.result && totalPieces(s) !== 34) total = false;
        }
        for (const k of Object.keys(s.stats.fires)) fired[k] = (fired[k] || 0) + s.stats.fires[k];
      }
    }
    console.log(`  （参考）モック4 80局：予測と比べた手 ${compared} 回（${JSON.stringify(byType)}）・2段以上の手 ${deep}・運ぶ（改）の選択肢が2体以上の移動 ${choiceOffered}・発動 ${JSON.stringify(fired)}`);
    check('予測(モック4): 自動対戦の全ての移動（carry の選択を含む）・投げる・入れ替えで、予測と実際の解決の盤・決着が一致する', compared > 0 && byType.throw > 0 && byType.swap > 0 && byType.carry > 0 && mismatch === 0);
    check('能力(モック4): 自動対戦で新しい能力6種がすべて実際に起きている（検査が空振りしていない）', ['carryAny', 'exchange', 'slip', 'recoil', 'blast', 'drag'].every((k) => fired[k] > 0));
    check('連鎖(モック4): 自動対戦で2段以上の連鎖が起きている', deep > 0);
    check('運ぶ(改)(モック4): 自動対戦で候補が2体以上の選択が実際に出ている', choiceOffered > 0);
    check('不変条件(モック4): 駒の総数は常に34', total);
    check('フィルタ(モック4): 相手の手札・両者の山・相手のドラフトの2枚が含まれない', !leaked);
    check('フィルタ(モック4): フィルタ後の state でも本人の合法手は同じ（入れ替え・carry の選択を含む）', legalSame);
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

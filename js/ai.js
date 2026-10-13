/**
 * ai.js — CPU（v0.3 モック1・CG-021 ＋ モック2・CG-023 ＋ モック3・CG-024 ＋ モック4・CG-025）。engine の外側に置く
 *
 * 【制約】CLAUDE.md §2.6
 *   - AI が見てよいのは filterStateFor(state, playerId) を通した state だけ
 *     （decide の最初で必ずフィルタを通す。呼び出し側が完全な state を渡しても覗けない）
 *   - (state, playerId) => action。AI 自身は乱数の状態を持たない
 *   - 合法性は engine に訊く（legalActions / battleOutcome / kingFallsBy / effectiveStrength）。ここでルールを書き写さない
 *   - ★ 勝敗は実際の強さで判断する（battleOutcome）。押し出しの連鎖の先でキングが倒れるかは
 *     kingFallsBy が打つ前の結果予測（previewMove＝実際の解決と同じ関数）で読む。それ以上は読まない（CG-023）
 *   - ★ モック3：投げる（手番の行動）も「動かす」と同じに扱う。投げて勝てる攻撃は「取る」の候補に入り、
 *     投げて倒れるキングは kingFallsByAction（previewThrow）で読む。前線基地を狙うといった戦略は入れない（CG-024）
 *   - ★ モック4：入れ替え（手番の行動）も「動かす」と同じに扱う（倒れるキングは kingFallsByAction で読む）。
 *     運ぶ（改）の選択（action の carry）は、engine が並べた順番（候補の決め打ちの順番）の先頭を必ず使う。
 *     合法手のうち同じ移動の carry 違いは先頭の1つだけを残してから選ぶ（random も greedy も。CG-025）
 *   - 癖は data/ai.js。ここに数値をベタ書きしない
 *
 * 【CPU は2種】（CG-021。強い CPU は作らない）
 *   random … 合法手から一様に選ぶ
 *   greedy … キングを取れるなら取る。取れる駒があれば取る（実際の強さが強い駒から）。
 *            それ以外は負ける攻撃・同値の攻撃を外した残りから random と同じ選び方
 *
 * 【「ランダム」の作り方】★ CLAUDE.md §2.6「乱数を使わない」との関係
 *   指示で「合法手からランダムに選ぶ CPU」が必要になった。AI に乱数の状態を持たせる代わりに、
 *   フィルタ済みの state（手数・盤面・保留）と salt を混ぜたハッシュで選ぶ。
 *   → 同じ state・同じ salt からは常に同じ手が出る（§2.6 の決定性は保たれる）。
 *     salt は自動対戦のシードから作るので、「同じシードなら同じ対戦」になる。
 *
 * 【読み込み形式】CG-008 を踏襲。ブラウザ＝グローバル NECRO_AI_CPU、Node＝module.exports
 */

(function (root) {
'use strict';

const E = typeof require === 'function' && typeof module !== 'undefined'
  ? require('./engine.js')
  : root.NECRO_ENGINE;

/** FNV-1a 32bit */
function hash32(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

function pickIndex(view, playerId, salt, n) {
  const key = [salt, playerId, view.ply, view.pending.length, view.cells.join(',')].join('|');
  return hash32(key) % n;
}

/**
 * @param {object} state 完全な state でもフィルタ済みでもよい（必ずここでフィルタを通す）
 * @param {string} playerId
 * @param {object} aiData data/ai.js
 * @param {object} [opts] { kind: 'greedy' | 'random', salt: number|string }
 * @returns {object|null} action
 */
function decide(state, playerId, aiData, opts) {
  const kind = (opts && opts.kind) || 'greedy';
  const salt = opts && opts.salt !== undefined ? opts.salt : 0;
  const view = E.filterStateFor(state, playerId);
  const acts = collapseChoices(E.legalActions(view, playerId));
  if (acts.length === 0) return null;
  if (kind === 'random') return acts[pickIndex(view, playerId, salt, acts.length)];
  return greedy(view, playerId, acts, aiData.greedy, salt);
}

/**
 * 同じ移動で carry（運ぶ（改）の選択）だけが違う手を、先頭（engine が並べた決め打ちの順番の先頭）の1つにまとめる（CG-025）。
 * ★ carry を持たない手は触らない（モック1〜3の合法手の並びは変わらない）
 */
function collapseChoices(acts) {
  const seen = new Set();
  return acts.filter((a) => {
    if (a.carry === undefined) return true;
    const k = `${a.type}|${a.from}|${a.to}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

function greedy(view, playerId, acts, g, salt) {
  const opp = E.opponentOf(playerId);
  const pend = view.pending[0];

  // ドラフト：強い方（カードの基礎の強さ）を自分に残す
  if (pend && pend.type === 'draft') {
    if (g.draftKeep !== 'stronger') return acts[0];
    let best = 0;
    for (let i = 1; i < pend.options.length; i++) {
      if (view.pieces[pend.options[i]].strength > view.pieces[pend.options[best]].strength) best = i;
    }
    return { type: 'draftPick', keep: best };
  }
  // 寝返りの配置：選び方は random と同じ
  if (pend) return acts[pickIndex(view, playerId, salt, acts.length)];

  // 盤の上の駒を使う手（動かす・投げる）。★ 投げるは from＝投げられる駒、to＝着地点で、戦闘の勝敗は動かすと同じく
  //   battleOutcome(from, to) で読める（投げられた駒の実際の強さは投げられる前のマスでの値）
  const moves = acts.filter((a) => a.type === 'move' || a.type === 'throw' || a.type === 'swap');
  // 1. キングを取れるなら取る
  const kill = moves.find((a) => E.kingFallsByAction(view, a) === opp);
  if (kill) return kill;
  // 2. 取れるなら取る（自分のキングが倒れる手は除く）
  const selfFalls = (a) => {
    const k = E.kingFallsByAction(view, a);
    return k === playerId || k === 'both';
  };
  const takes = moves.filter((a) => {
    const o = E.battleOutcome(view, a.from, a.to);
    return !selfFalls(a) && (o === 'win' || (g.takeTies && o === 'tie'));
  });
  if (takes.length > 0) {
    if (g.captureOrder !== 'strongestTarget') return takes[0];
    let best = takes[0];
    for (const a of takes) {
      if (E.effectiveStrength(view, a.to) > E.effectiveStrength(view, best.to)) best = a;
    }
    return best;
  }
  // 3. それ以外：負ける攻撃・同値の攻撃・自分のキングが倒れる手を外して選ぶ
  const pool = acts.filter((a) => {
    if (a.type !== 'move' && a.type !== 'throw' && a.type !== 'swap') return true;
    if (selfFalls(a)) return false;
    const o = E.battleOutcome(view, a.from, a.to);
    if (o === 'lose' && g.avoidLosingAttacks) return false;
    if (o === 'tie' && g.avoidTies) return false;
    return true;
  });
  const from = pool.length > 0 ? pool : acts;
  return from[pickIndex(view, playerId, salt, from.length)];
}

const ai = { decide, hash32, collapseChoices };
root.NECRO_AI_CPU = ai;
if (typeof module !== 'undefined' && module.exports) module.exports = ai;

// ===========================================================================
// Node 単体実行時のセルフテスト
//   $ node js/ai.js
// ===========================================================================

const isNodeMain =
  typeof process !== 'undefined' &&
  !!(process.versions && process.versions.node) &&
  typeof process.argv[1] === 'string' &&
  /[\\/]ai\.js$/.test(process.argv[1]) &&
  !/data[\\/]ai\.js$/.test(process.argv[1]);

if (isNodeMain) {
  const path = require('node:path');
  const cardData = require(path.join(__dirname, '..', 'data', 'cards.js'));
  const aiData = require(path.join(__dirname, '..', 'data', 'ai.js'));
  let failures = 0;
  let checks = 0;
  const check = (label, cond) => {
    checks++;
    if (cond) console.log(`  ok   ${label}`);
    else { console.log(`  FAIL ${label}`); failures++; }
  };

  // ★ モック1・モック2の検査は前線基地（CG-024）を切って行う（CG-023 までの振る舞いのまま検査する）
  const M1 = { pieceSet: 'mock1', frontBase: false };
  function play(seed, kinds, overrides) {
    let s = E.createInitialState(seed, cardData, overrides);
    let illegal = false;
    const actions = [];
    while (!s.result) {
      const who = E.decider(s);
      const a = decide(s, who, aiData, { kind: kinds[who], salt: seed });
      const legal = E.legalActions(s, who).map(E.actionKey);
      if (!legal.includes(E.actionKey(a))) { illegal = true; break; }
      actions.push(a);
      s = E.reduce(s, a);
    }
    return { state: s, actions, illegal };
  }

  console.log('ai.js セルフテスト（v0.3 モック1・モック2・モック3・モック4）');

  // 決定性
  {
    const a = play(1000, { p1: 'greedy', p2: 'greedy' });
    const b = play(1000, { p1: 'greedy', p2: 'greedy' });
    check('決定性: 同じシード・同じ CPU なら同じ対戦', JSON.stringify(a.state) === JSON.stringify(b.state));
    const r1 = play(1001, { p1: 'random', p2: 'random' });
    const r2 = play(1001, { p1: 'random', p2: 'random' });
    check('決定性: random も同じシードなら同じ対戦', JSON.stringify(r1.state) === JSON.stringify(r2.state));
    check('決定性: 別シードなら別の展開', JSON.stringify(a.state) !== JSON.stringify(play(1002, { p1: 'greedy', p2: 'greedy' }).state));
  }

  // 合法手しか返さない
  {
    let ok = true;
    for (let seed = 3000; seed < 3040; seed++) {
      for (const kinds of [{ p1: 'greedy', p2: 'random' }, { p1: 'random', p2: 'greedy' }]) {
        if (play(seed, kinds).illegal) ok = false;
        if (play(seed, kinds, { drawMode: 'action', winnerLosesStrength: true, defectorPlacement: 'winner' }).illegal) ok = false;
        if (play(seed, kinds, { ...M1, winnerLosesStrength: true }).illegal) ok = false;
      }
    }
    check('合法: 80局×3設定（モック2×2・モック1×1）で常に合法手を返す', ok);
  }

  // 隠し情報を見ない：相手の手札・両者の山の中身を入れ替えても同じ手
  {
    let same = true;
    let s = E.createInitialState(1010, cardData);
    for (let i = 0; i < 80 && !s.result; i++) {
      const who = E.decider(s);
      const opp = E.opponentOf(who);
      // 相手の手札と両者の山を互いに入れ替えた別の state（見えるはずのない部分だけが違う）
      const swapped = {
        ...s,
        players: {
          ...s.players,
          [opp]: { ...s.players[opp], hand: s.players[opp].deck.slice(0, s.players[opp].hand.length), deck: [...s.players[opp].hand, ...s.players[opp].deck.slice(s.players[opp].hand.length)] },
          [who]: { ...s.players[who], deck: s.players[who].deck.slice().reverse() },
        },
        rng: { s: 12345 },
      };
      for (const kind of ['greedy', 'random']) {
        const a1 = decide(s, who, aiData, { kind, salt: 7 });
        const a2 = decide(swapped, who, aiData, { kind, salt: 7 });
        if (E.actionKey(a1) !== E.actionKey(a2)) same = false;
      }
      s = E.reduce(s, decide(s, who, aiData, { kind: 'random', salt: 9 }));
    }
    check('隠し情報: 相手の手札・両者の山を入れ替えても同じ手を選ぶ', same);
  }

  // 貪欲の中身（モック1の駒で）
  {
    const base = E.createInitialState(1, cardData, M1);
    const empty = { ...base, cells: base.cells.map(() => null), pending: [] };
    const take = (s, owner, kind) => [...s.players[owner].deck, ...s.players[owner].hand].find((i) => s.pieces[i].kind === kind && !s.cells.includes(i));
    const place = (s, id, sq, controller) => {
      const cells = s.cells.slice();
      cells[E.squareIndex(s, sq)] = id;
      const owner = s.pieces[id].owner;
      return {
        ...s,
        cells,
        pieces: { ...s.pieces, [id]: { ...s.pieces[id], controller: controller || owner } },
        players: { ...s.players, [owner]: { ...s.players[owner], deck: s.players[owner].deck.filter((x) => x !== id), hand: s.players[owner].hand.filter((x) => x !== id) } },
      };
    };
    let s = place(place(empty, 'p1-K', 'D7'), 'p2-K', 'D3');
    s = place(s, take(s, 'p1', 'queen'), 'D5');
    s = place(s, take(s, 'p2', 'rook'), 'A5');
    s = { ...s, active: 'p1' };
    check('貪欲: キングを取れるならキングを取る', E.actionKey(decide(s, 'p1', aiData, { kind: 'greedy' })) === E.actionKey({ type: 'move', from: 'D5', to: 'D3' }));
    let t = place(place(empty, 'p1-K', 'D7'), 'p2-K', 'G1');
    t = place(t, take(t, 'p1', 'queen'), 'D5');
    t = place(t, take(t, 'p2', 'pawn'), 'D4');
    t = place(t, take(t, 'p2', 'rook'), 'A5');
    t = { ...t, active: 'p1' };
    check('貪欲: 取れる駒が複数あれば強い駒を取る', E.actionKey(decide(t, 'p1', aiData, { kind: 'greedy' })) === E.actionKey({ type: 'move', from: 'D5', to: 'A5' }));
    let u = place(place(empty, 'p1-K', 'D7'), 'p2-K', 'G1');
    u = place(u, take(u, 'p1', 'pawn'), 'C5');
    u = place(u, take(u, 'p2', 'rook'), 'D4');
    u = { ...u, active: 'p1' };
    let lost = false;
    for (let salt = 0; salt < 50; salt++) {
      const a = decide(u, 'p1', aiData, { kind: 'greedy', salt });
      if (a.type === 'move' && a.to === 'D4') lost = true;
    }
    check('貪欲: 負ける攻撃は選ばない', !lost);
    // ドラフトで強い方を残す
    const d = { ...u, pending: [{ type: 'draft', player: 'p1', options: [take(u, 'p1', 'pawn'), take(u, 'p1', 'rook')] }] };
    check('貪欲: ドラフトでは強い方を自分に残す', decide(d, 'p1', aiData, { kind: 'greedy' }).keep === 1);
  }

  // 貪欲の中身（モック2：実際の強さと押し出しの連鎖・CG-023）
  {
    const base = E.createInitialState(1, cardData, { pieceSet: 'mock2', frontBase: false });
    const empty = { ...base, cells: base.cells.map(() => null), pending: [] };
    const used = new Set();
    const take = (s, owner, kind) => [...s.players[owner].deck, ...s.players[owner].hand].find((i) => s.pieces[i].kind === kind && !s.cells.includes(i) && !used.has(i));
    const place = (s, owner, kind, sq, controller) => {
      const id = owner === null ? kind : take(s, owner, kind);
      used.add(id);
      const cells = s.cells.slice();
      cells[E.squareIndex(s, sq)] = id;
      return { ...s, cells, pieces: { ...s.pieces, [id]: { ...s.pieces[id], controller: controller || s.pieces[id].owner } } };
    };
    // 基礎の強さなら同値（1 対 1）だが、防御側は槍衾で 3 になる → 攻めない
    let s = place(place(empty, null, 'p1-K', 'G7'), null, 'p2-K', 'A1');
    s = place(s, 'p1', 'pawn', 'C5');
    s = place(s, 'p2', 'pawn', 'D4');
    s = place(s, 'p2', 'knightPhalanx', 'D3');
    s = { ...s, active: 'p1' };
    let attacked = false;
    for (let salt = 0; salt < 50; salt++) {
      const a = decide(s, 'p1', aiData, { kind: 'greedy', salt });
      if (a.type === 'move' && a.to === 'D4') attacked = true;
    }
    check('貪欲(モック2): 実際の強さで負ける攻撃（防御側が槍衾で 3）は選ばない', !attacked && E.battleOutcome(s, 'C5', 'D4') === 'lose');
    // 実際の強さで勝てるなら取る（鼓舞で 2 対 1）
    used.clear();
    let u = place(place(empty, null, 'p1-K', 'G7'), null, 'p2-K', 'A1');
    u = place(u, 'p1', 'pawn', 'C5');
    u = place(u, 'p1', 'queenInspire', 'B6');
    u = place(u, 'p2', 'pawn', 'D4');
    u = { ...u, active: 'p1' };
    check('貪欲(モック2): 実際の強さで勝てる攻撃（鼓舞で 2 対 1）は取る', E.actionKey(decide(u, 'p1', aiData, { kind: 'greedy' })) === E.actionKey({ type: 'move', from: 'C5', to: 'D4' }));
    // 押し出しの連鎖の先で自分のキングが倒れる攻撃は選ばない
    used.clear();
    let k = place(place(empty, null, 'p1-K', 'D2'), null, 'p2-K', 'G1');
    k = place(k, 'p1', 'rookPush', 'D6');
    k = place(k, 'p2', 'pawn', 'D4');
    k = place(k, 'p1', 'queenInspire', 'D3');   // 押されてキング（3＋鼓舞1＝4）と同値 → キングが倒れる
    k = { ...k, active: 'p1' };
    let suicide = false;
    for (let salt = 0; salt < 50; salt++) {
      const a = decide(k, 'p1', aiData, { kind: 'greedy', salt });
      if (a.type === 'move' && a.from === 'D6' && a.to === 'D4') suicide = true;
    }
    check('貪欲(モック2): 押し出しの連鎖の先で自分のキングが倒れる攻撃は選ばない（予測で読む）', E.battleOutcome(k, 'D6', 'D4') === 'win' && E.kingFallsBy(k, 'D6', 'D4') === 'p1' && !suicide);
    // 押し出しの連鎖の先で相手のキングが倒れるなら、ほかに強い駒が取れてもそれを選ぶ
    used.clear();
    let w = place(place(empty, null, 'p1-K', 'G7'), null, 'p2-K', 'D2');
    w = place(w, 'p1', 'rookPush', 'D6');
    w = place(w, 'p2', 'pawn', 'D4');
    // 押されるのはナイト（D2 へは自分では行けない）。C3 のナイトの槍衾で 2＋2＝4 になり、D2 のキング（3）を倒す
    w = place(w, 'p1', 'knightPhalanx', 'D3');
    w = place(w, 'p1', 'knightPhalanx', 'C3');
    w = place(w, 'p1', 'rookImmovable', 'A6');
    w = place(w, 'p2', 'knightPhalanx', 'A4');
    w = { ...w, active: 'p1' };
    check('貪欲(モック2): 押し出しの連鎖の先で相手のキングを倒せるなら、それを選ぶ', E.kingFallsBy(w, 'D6', 'D4') === 'p2' && E.actionKey(decide(w, 'p1', aiData, { kind: 'greedy' })) === E.actionKey({ type: 'move', from: 'D6', to: 'D4' }));
  }

  // 貪欲の中身（モック3：投げる・CG-024）
  {
    const base = E.createInitialState(1, cardData, { pieceSet: 'mock3' });
    const empty = { ...base, cells: base.cells.map(() => null), pending: [] };
    const used = new Set();
    const take = (s, owner, kind) => [...s.players[owner].deck, ...s.players[owner].hand].find((i) => s.pieces[i].kind === kind && !s.cells.includes(i) && !used.has(i));
    const place = (s, owner, kind, sq) => {
      const id = owner === null ? kind : take(s, owner, kind);
      used.add(id);
      const cells = s.cells.slice();
      cells[E.squareIndex(s, sq)] = id;
      return { ...s, cells };
    };
    // 投げて勝てる攻撃しか取れる手がない：投げるを選ぶ（D5 のクイーンを D4 越しに D2 の敵ポーンへ。
    // ビショップは D2 へ動けず、クイーンは D4 に塞がれて届かない）
    let s = place(place(empty, null, 'p1-K', 'G7'), null, 'p2-K', 'A3');
    s = place(s, 'p1', 'bishopHurl', 'D4');
    s = place(s, 'p1', 'queenInspire', 'D5');
    s = place(s, 'p2', 'pawn', 'D2');
    s = { ...s, active: 'p1' };
    const takesByMove = E.legalActions(s, 'p1').filter((a) => a.type === 'move' && E.battleOutcome(s, a.from, a.to));
    const a = decide(s, 'p1', aiData, { kind: 'greedy' });
    check('貪欲(モック3): 投げて勝てる攻撃は「取る」の候補に入る（動かして取れる手がなければ投げる）', takesByMove.length === 0 && a.type === 'throw' && a.from === 'D5' && a.to === 'D2');
    // 投げて相手のキングを倒せるなら、ほかに取れる駒があってもそれを選ぶ
    used.clear();
    let k = place(place(empty, null, 'p1-K', 'A7'), null, 'p2-K', 'D2');
    k = place(k, 'p1', 'bishopHurl', 'D4');
    k = place(k, 'p1', 'queenInspire', 'D5');
    k = place(k, 'p2', 'pawn', 'G6');
    k = place(k, 'p1', 'knightPhalanx', 'E7');   // G6 のポーンを動かして取れる手もある
    k = { ...k, active: 'p1' };
    check('貪欲(モック3): 投げて相手のキングを倒せるならそれを選ぶ', E.kingFallsByAction(k, { type: 'throw', from: 'D5', to: 'D2' }) === 'p2' && E.battleOutcome(k, 'E7', 'G6') === 'win' && E.actionKey(decide(k, 'p1', aiData, { kind: 'greedy' })) === E.actionKey({ type: 'throw', from: 'D5', to: 'D2' }));
    // 投げて負ける攻撃は選ばない
    used.clear();
    let l = place(place(empty, null, 'p1-K', 'G7'), null, 'p2-K', 'A3');
    l = place(l, 'p1', 'bishopHurl', 'D4');
    l = place(l, 'p1', 'pawn', 'D5');
    l = place(l, 'p2', 'rookImmovable', 'D2');
    l = { ...l, active: 'p1' };
    let lostThrow = false;
    for (let salt = 0; salt < 50; salt++) {
      const x = decide(l, 'p1', aiData, { kind: 'greedy', salt });
      if (x.type === 'throw' && x.to === 'D2') lostThrow = true;
    }
    check('貪欲(モック3): 投げて負ける攻撃は選ばない', E.battleOutcome(l, 'D5', 'D2') === 'lose' && !lostThrow);
    // 合法手しか返さない（モック3・前線基地あり）
    let ok = true;
    for (let seed = 3100; seed < 3130; seed++) {
      for (const kinds of [{ p1: 'greedy', p2: 'random' }, { p1: 'greedy', p2: 'greedy' }]) {
        if (play(seed, kinds, { pieceSet: 'mock3' }).illegal) ok = false;
        if (play(seed, kinds, { pieceSet: 'mock3', winnerLosesStrength: true, kingStrength: 6 }).illegal) ok = false;
      }
    }
    check('合法(モック3): 60局×2設定で常に合法手を返す（投げる・前線基地を含む）', ok);
  }

  // 貪欲・ランダムの中身（モック4：運ぶ（改）の選択・入れ替え・爆風・CG-025）
  {
    const base = E.createInitialState(1, cardData, { pieceSet: 'mock4' });
    const empty = { ...base, cells: base.cells.map(() => null), pending: [] };
    const used = new Set();
    const take = (s, owner, kind) => [...s.players[owner].deck, ...s.players[owner].hand].find((i) => s.pieces[i].kind === kind && !s.cells.includes(i) && !used.has(i));
    const place = (s, owner, kind, sq) => {
      const id = owner === null ? kind : take(s, owner, kind);
      used.add(id);
      const cells = s.cells.slice();
      cells[E.squareIndex(s, sq)] = id;
      return { ...s, cells };
    };
    // carry 違いの手は先頭（決め打ちの順番の先頭）だけが残る。モック1〜3の合法手は変わらない
    let s = place(place(empty, null, 'p1-K', 'G7'), null, 'p2-K', 'A1');
    s = place(s, 'p1', 'pawnCarryAny', 'C5');
    s = place(s, 'p1', 'pawn', 'D5');
    s = place(s, 'p1', 'pawnTriumph', 'B6');
    s = { ...s, active: 'p1', players: { ...s.players, p1: { ...s.players.p1, hand: [] } } };
    const all = E.legalActions(s, 'p1').filter((a) => a.from === 'C5' && a.to === 'C4');
    const col = collapseChoices(E.legalActions(s, 'p1')).filter((a) => a.from === 'C5' && a.to === 'C4');
    check('CPU(モック4): 同じ移動の carry 違い（D5・B6・運ばない）は先頭の D5 だけにまとめる', all.length === 3 && col.length === 1 && col[0].carry === 'D5');
    let picked = new Set();
    for (let salt = 0; salt < 200; salt++) {
      for (const kind of ['greedy', 'random']) {
        const a = decide(s, 'p1', aiData, { kind, salt });
        if (a.type === 'move' && a.from === 'C5' && a.to === 'C4') picked.add(a.carry);
      }
    }
    check('CPU(モック4): random・greedy とも運ぶ（改）は決め打ちの順番の先頭（D5）を選ぶ', picked.size === 1 && picked.has('D5'));
    const m3 = E.createInitialState(5, cardData, { pieceSet: 'mock3' });
    check('CPU: モック3の合法手は collapseChoices で変わらない', JSON.stringify(collapseChoices(E.legalActions(m3, 'p1'))) === JSON.stringify(E.legalActions(m3, 'p1')));
    // 爆風：空きマスへの投げで、押した先で相手のキングが倒れるならそれを選ぶ
    used.clear();
    let k = place(place(empty, null, 'p1-K', 'A7'), null, 'p2-K', 'F2');
    k = place(k, 'p1', 'bishopHurl', 'D4');
    k = place(k, 'p1', 'knightBlast', 'D5');
    k = place(k, 'p1', 'knightTraitor', 'E2');   // 自分では F2 へ動けない。押されて F2 のキング（3）と同値 → キングが倒れる（kingTie の既定）
    k = place(k, 'p2', 'pawn', 'B7');
    k = { ...k, active: 'p1' };
    check('貪欲(モック4): 爆風で押した駒が相手のキングを倒すなら、空きマスへの投げでも選ぶ', E.actionKey(decide(k, 'p1', aiData, { kind: 'greedy' })) === E.actionKey({ type: 'throw', from: 'D5', to: 'D2' }));
    // 合法手しか返さない・入れ替えも選ぶ（モック4）
    let ok = true;
    let swaps = 0;
    for (let seed = 3200; seed < 3230; seed++) {
      for (const kinds of [{ p1: 'greedy', p2: 'random' }, { p1: 'greedy', p2: 'greedy' }]) {
        for (const o of [{ pieceSet: 'mock4' }, { pieceSet: 'mock4', winnerLosesStrength: true, kingStrength: 6 }]) {
          const r = play(seed, kinds, o);
          if (r.illegal) ok = false;
          swaps += r.actions.filter((a) => a.type === 'swap').length;
        }
      }
    }
    check('合法(モック4): 60局×2設定で常に合法手を返す（carry の選択・入れ替え・爆風を含む）', ok);
    check('CPU(モック4): 入れ替えも選ぶ（合法手の一覧に出ている）', swaps > 0);
  }

  // 貪欲はランダムより強い（目安。測定値ではなく健全性の確認）
  {
    let gw = 0;
    let rw = 0;
    for (let seed = 5000; seed < 5040; seed++) {
      const kinds = seed % 2 ? { p1: 'greedy', p2: 'random' } : { p1: 'random', p2: 'greedy' };
      const g = seed % 2 ? 'p1' : 'p2';
      const r = play(seed, kinds).state.result;
      if (r.winner === g) gw++;
      else if (r.winner) rw++;
    }
    console.log(`  （参考）貪欲 vs ランダム 40局: 貪欲 ${gw} 勝・ランダム ${rw} 勝`);
    check('健全性: 貪欲がランダムに勝ち越す', gw > rw);
  }

  console.log(failures === 0 ? `\n${checks} 件すべて成功` : `\n${checks} 件中 ${failures} 件失敗`);
  if (failures > 0) process.exit(1);
}

})(typeof globalThis !== 'undefined' ? globalThis : this);

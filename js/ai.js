/**
 * ai.js — CPU（v0.3 モック1・CG-021）。engine の外側に置く
 *
 * 【制約】CLAUDE.md §2.6
 *   - AI が見てよいのは filterStateFor(state, playerId) を通した state だけ
 *     （decide の最初で必ずフィルタを通す。呼び出し側が完全な state を渡しても覗けない）
 *   - (state, playerId) => action。AI 自身は乱数の状態を持たない
 *   - 合法性は engine に訊く（legalActions / battleOutcome / kingFallsBy）。ここでルールを書き写さない
 *   - 癖は data/ai.js。ここに数値をベタ書きしない
 *
 * 【CPU は2種】（CG-021。強い CPU は作らない）
 *   random … 合法手から一様に選ぶ
 *   greedy … キングを取れるなら取る。取れる駒があれば取る（強い駒から）。
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
  const acts = E.legalActions(view, playerId);
  if (acts.length === 0) return null;
  if (kind === 'random') return acts[pickIndex(view, playerId, salt, acts.length)];
  return greedy(view, playerId, acts, aiData.greedy, salt);
}

function greedy(view, playerId, acts, g, salt) {
  const opp = E.opponentOf(playerId);
  const pend = view.pending[0];

  // ドラフト：強い方を自分に残す
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

  const moves = acts.filter((a) => a.type === 'move');
  // 1. キングを取れるなら取る
  const kill = moves.find((a) => E.kingFallsBy(view, a.from, a.to) === opp);
  if (kill) return kill;
  // 2. 取れるなら取る（自分のキングが倒れる手は除く）
  const selfFalls = (a) => {
    const k = E.kingFallsBy(view, a.from, a.to);
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
      if (E.pieceAt(view, a.to).strength > E.pieceAt(view, best.to).strength) best = a;
    }
    return best;
  }
  // 3. それ以外：負ける攻撃・同値の攻撃・自分のキングが倒れる手を外して選ぶ
  const pool = acts.filter((a) => {
    if (a.type !== 'move') return true;
    if (selfFalls(a)) return false;
    const o = E.battleOutcome(view, a.from, a.to);
    if (o === 'lose' && g.avoidLosingAttacks) return false;
    if (o === 'tie' && g.avoidTies) return false;
    return true;
  });
  const from = pool.length > 0 ? pool : acts;
  return from[pickIndex(view, playerId, salt, from.length)];
}

const ai = { decide, hash32 };
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

  console.log('ai.js セルフテスト（v0.3 モック1）');

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
      }
    }
    check('合法: 80局×2設定で常に合法手を返す', ok);
  }

  // 隠し情報を見ない：相手の手札・両者の山の中身を入れ替えても同じ手
  {
    let same = true;
    let s = E.createInitialState(1010, cardData);
    for (let i = 0; i < 60 && !s.result; i++) {
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

  // 貪欲の中身
  {
    const base = E.createInitialState(1, cardData);
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

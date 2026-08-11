/**
 * ai.js — 評価関数ベースの CPU（CG-006）
 *
 * 【位置づけ】
 *   engine の外側に置く。engine はルール、こちらは「対戦相手の考え方」。
 *   ★ 将来オンライン対戦の権威サーバでそのまま再利用できるようにするため、
 *     CPU は必ず filterStateFor を通した state だけを見る。
 *     相手の手札とデッキの中身は engine の視点フィルタが落とすので、
 *     このファイルはそれらに触れようがない構造になっている。
 *
 * 【制約】
 *   - DOM / window / document に触らない。Node 単体で実行できること（`node js/ai.js`）
 *   - (state, playerId) => action の純粋関数。state を破壊的に変更しない
 *   - 乱数を使わない。同じ state からは常に同じ action が出る
 *   - 重みは data/ai.json。ここに数値をベタ書きしない
 *
 * 【強さ】
 *   追求しない。1手先だけを読む貪欲法で、「盤面を維持する」「有利トレードを選ぶ」
 *   「空き枠を埋める」程度の動機を持たせてある。
 */

import {
  filterStateFor,
  reduce,
  legalActions,
  canSummon,
  attackOf,
  healthLeft,
  opponentOf,
  defOf,
  slotIndex,
  slotRowCol,
  graveyardSummonTax,
  graveyardCostTotal,
  summonSourceOwner,
} from './engine.js';

// ===========================================================================
// サンドボックス
//
// 候補手の評価には engine の reduce をそのまま使う（AI 側にルールを書き写さない）。
// ただし視点フィルタ済みの state にはデッキの中身が無いので、
// 「AI から見えないものは空」として扱えるよう整えてから reduce に渡す。
//   - deck: [] … デッキの中身は知らない。ドローも c07 のデッキ送りも起きない扱いになる
//   - hand: 相手の手札は中身が無いので []（枚数は handCount で持っている）
//   - log:  [] … 長いログを候補手ごとに複製しないため
// ===========================================================================

/**
 * トークンの iid 採番の起点。実際の対局では
 * nextInstance ＝ デッキ総数（60超）から始まるので、
 * 十分大きな値にしておけば実在の iid と衝突しない。
 */
const SANDBOX_INSTANCE_BASE = 900000;

export function sandboxOf(view) {
  const players = {};
  for (const pid of Object.keys(view.players)) {
    const p = view.players[pid];
    players[pid] = { ...p, deck: [], hand: p.hand || [] };
  }
  return { ...view, players, nextInstance: SANDBOX_INSTANCE_BASE, log: [] };
}

// ===========================================================================
// 評価関数
// ===========================================================================

/**
 * 手札の枚数。自分は実体、相手は枚数だけを見る。
 * ★ reduce を通したあとの handCount は更新されないが、
 *   相手の手札は自分の手番中に増減しないので枚数は正しいままである。
 */
function handSize(v, side, me) {
  return side === me ? v.players[side].hand.length : v.players[side].handCount;
}

/** ネクロマンサーの残り体力 */
function necromancerLeft(v, pid) {
  return healthLeft(v, v.players[pid].necromancer);
}

/** 盤面の価値。存在・攻撃力・残り体力＋（後列で守られていれば）上乗せ */
function boardValue(v, pid, w) {
  const board = v.players[pid].board;
  let total = 0;
  for (let s = 0; s < board.length; s++) {
    const iid = board[s];
    if (!iid) continue;
    total +=
      w.unitPresence +
      w.unitAttack * attackOf(v, iid) +
      w.unitHealth * Math.max(0, healthLeft(v, iid));
    const { row, col } = slotRowCol(s, v.rules);
    if (row > 0 && board[slotIndex(0, col, v.rules)]) total += w.protectedUnit;
  }
  return total;
}

/**
 * 局面を playerId 視点で採点する。大きいほど playerId に有利。
 * @param {object} v filterStateFor 済み（またはそれを reduce したあとの）state
 */
export function evaluateState(v, playerId, ai) {
  const w = ai.weights;
  if (v.winner) return v.winner === playerId ? w.win : -w.win;

  const foe = opponentOf(playerId);
  let score = boardValue(v, playerId, w) - boardValue(v, foe, w) * w.foeUnitScale;
  score += w.necromancerHealth * (necromancerLeft(v, playerId) - necromancerLeft(v, foe));
  score += w.handCard * (handSize(v, playerId, playerId) - handSize(v, foe, playerId));
  // 墓地の総コストは reduce では再計算されない項なので、必ず配列から数え直す
  score += w.graveyardCost * (graveyardCostTotal(v, playerId) - graveyardCostTotal(v, foe));
  return score;
}

// ===========================================================================
// 召喚候補の組み立て
// ===========================================================================

/**
 * need pt を払える最小のピッチを探す。
 * 合計コストが need 以上になる組のうち、合計が最小・枚数が少ないものを選ぶ。
 * ★ 「余分に払わない」＝「相手の墓地へ渡す資源を最小にする」でもある。
 * 1〜2枚は総当たり、足りなければ高い順に足す貪欲。
 * @returns {string[]|null} ピッチする iid の配列。払えないときは null
 */
function cheapestPitch(v, playerId, excludeIid, need) {
  if (need <= 0) return [];
  const hand = v.players[playerId].hand.filter((iid) => iid !== excludeIid);
  // コスト昇順・iid 昇順に固定してから探す（同値のときの選び方を決定的にする）
  const sorted = hand.slice().sort((a, b) => {
    const d = defOf(v, a).cost - defOf(v, b).cost;
    return d !== 0 ? d : a < b ? -1 : a > b ? 1 : 0;
  });
  const costOf = (iid) => defOf(v, iid).cost;

  let best = null;
  const consider = (set) => {
    const sum = set.reduce((s, iid) => s + costOf(iid), 0);
    if (sum < need) return;
    if (!best || sum < best.sum || (sum === best.sum && set.length < best.set.length)) {
      best = { sum, set };
    }
  };
  for (let i = 0; i < sorted.length; i++) {
    consider([sorted[i]]);
    for (let j = i + 1; j < sorted.length; j++) consider([sorted[i], sorted[j]]);
  }
  if (best) return best.set;

  // 2枚で足りない場合だけ、高い順に足していく
  const set = [];
  let sum = 0;
  for (let i = sorted.length - 1; i >= 0; i--) {
    set.push(sorted[i]);
    sum += costOf(sorted[i]);
    if (sum >= need) return set;
  }
  return null;
}

/**
 * 召喚 action の候補を列挙する。
 * 同じカード（cardId）は入れ替えても結果が同じなので1枚に畳む。
 * 枠は空きすべてを候補にする（c06 の「右に空きがあるか」は
 * reduce がトークンを実際に出してくれるので、評価側が自然に選び分ける）。
 */
function summonCandidates(v, playerId, ai) {
  const me = v.players[playerId];
  const out = [];

  const empties = [];
  for (let s = 0; s < me.board.length; s++) if (!me.board[s]) empties.push(s);
  if (empties.length === 0) return out;

  const tax = graveyardSummonTax(v, playerId);
  const src = summonSourceOwner(v, playerId);

  const picks = [];
  const seen = new Set();
  for (const iid of me.hand) {
    const key = `h:${v.cards[iid].cardId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    picks.push({ iid, from: 'hand' });
  }
  for (const iid of v.players[src].graveyard) {
    const key = `g:${v.cards[iid].cardId}`;
    if (seen.has(key)) continue;
    // トークンはコスト0なのでピッチ0枚で出し直せる。自粛させたいときの逃げ道
    // （ルールを変える設定ではない。data/ai.json の _reviveTokens を参照）
    if (ai.search.reviveTokens === false && defOf(v, iid).token) continue;
    seen.add(key);
    picks.push({ iid, from: 'graveyard' });
  }

  for (const pick of picks) {
    const need = defOf(v, pick.iid).cost + (pick.from === 'graveyard' ? tax : 0);
    const pitch = cheapestPitch(v, playerId, pick.from === 'hand' ? pick.iid : null, need);
    if (pitch === null) continue;
    for (const slot of empties) {
      const plays = [{ ...pick, slot }];
      // 合法性の判断は engine に委ねる（AI 側でコストを数え直さない）
      if (!canSummon(v, playerId, pitch, plays).ok) continue;
      out.push({ type: 'summon', pitch, plays });
    }
  }
  return out;
}

/**
 * 候補手の一覧。ドローとターン終了は含めない（呼び出し側が別に扱う）。
 * 攻撃・配置換えは engine の legalActions から取る（AI 側で合法性を判定しない）。
 */
function candidateActions(v, playerId, ai) {
  const me = v.players[playerId];
  const out = [];
  for (const a of legalActions(v, playerId)) {
    if (a.type === 'draw' || a.type === 'endTurn') continue;
    if (a.type === 'reposition' && me.repositionsUsed >= ai.search.maxRepositionsPerTurn) continue;
    out.push(a);
  }
  for (const a of summonCandidates(v, playerId, ai)) out.push(a);
  return out;
}

// ===========================================================================
// 本体
// ===========================================================================

/**
 * その局面で CPU が指す action を1つ返す。
 *
 * ★ 純粋関数。state を変更せず、乱数も使わない。
 * ★ 内部で必ず filterStateFor を通すので、相手の手札とデッキは見ていない。
 *
 * @param {object} state engine の完全な state（権威サーバでも同じ形で渡せる）
 * @param {string} playerId
 * @param {object} ai data/ai.json の内容
 * @returns {object} JSON 化可能な action
 */
export function chooseCpuAction(state, playerId, ai) {
  const v = filterStateFor(state, playerId);
  if (v.winner || v.active !== playerId) return { type: 'endTurn' };

  // ドローは常に得（デッキ切れ敗北が無いルールのため）。まず引く。
  if (legalActions(v, playerId).some((a) => a.type === 'draw')) return { type: 'draw' };

  const sandbox = sandboxOf(v);
  const base = evaluateState(sandbox, playerId, ai);

  let best = null;
  for (const action of candidateActions(v, playerId, ai)) {
    let after;
    try {
      after = reduce(sandbox, action);
    } catch {
      continue; // 合法手のはずだが、読み違えたら黙って捨てる
    }
    const score = evaluateState(after, playerId, ai);
    // 同点なら先に列挙された手を採る（列挙順は決定的なので結果も決定的）
    if (!best || score > best.score) best = { score, action };
  }

  if (best && best.score > base + ai.search.minGain) return best.action;
  return { type: 'endTurn' };
}

/** ai を束ねた `(state, playerId) => action` を作る */
export function makeCpu(ai) {
  return (state, playerId) => chooseCpuAction(state, playerId, ai);
}

// ===========================================================================
// Node 単体実行時のセルフテスト
//   $ node js/ai.js
// ===========================================================================

const isNodeMain =
  typeof process !== 'undefined' &&
  !!process.versions?.node &&
  typeof process.argv?.[1] === 'string' &&
  /ai\.js$/.test(process.argv[1]);

if (isNodeMain) {
  const { readFileSync } = await import('node:fs');
  const { fileURLToPath } = await import('node:url');
  const path = await import('node:path');
  const { createInitialState, boardSize, PLAYERS } = await import('./engine.js');

  const here = path.dirname(fileURLToPath(import.meta.url));
  const cardData = JSON.parse(readFileSync(path.join(here, '..', 'data', 'cards.json'), 'utf8'));
  const aiData = JSON.parse(readFileSync(path.join(here, '..', 'data', 'ai.json'), 'utf8'));
  const rules = cardData.rules;

  let failures = 0;
  let checks = 0;
  const check = (label, cond) => {
    checks++;
    console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${label}`);
    if (!cond) failures++;
  };

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

  function place(s, pid, slot, iid) {
    const board = s.players[pid].board.slice();
    board[slot] = iid;
    return {
      ...s,
      players: { ...s.players, [pid]: { ...s.players[pid], board } },
      cards: { ...s.cards, [iid]: { ...s.cards[iid], controller: pid, damage: 0, attacksUsed: 0 } },
    };
  }

  const setHand = (s, pid, hand) => ({
    ...s,
    players: { ...s.players, [pid]: { ...s.players[pid], hand } },
  });
  const ready = (s, pid) => ({
    ...s,
    active: pid,
    players: { ...s.players, [pid]: { ...s.players[pid], drawUsed: true } },
  });

  console.log('ai.js セルフテスト（評価関数ベース CPU / CG-006）');

  // --- 1. 決定性 ---
  {
    const s = createInitialState(5001, cardData);
    const a1 = chooseCpuAction(s, 'p1', aiData);
    const a2 = chooseCpuAction(s, 'p1', aiData);
    check('同じ state からは同じ action が出る', JSON.stringify(a1) === JSON.stringify(a2));
    check('action は JSON 化できる', JSON.stringify(a1) === JSON.stringify(JSON.parse(JSON.stringify(a1))));
  }

  // --- 2. 非破壊性 ---
  {
    const s = createInitialState(5002, cardData);
    const before = JSON.stringify(s);
    chooseCpuAction(s, 'p1', aiData);
    check('CPU は state を変更しない', JSON.stringify(s) === before);
  }

  // --- 3. 隠し情報を見ていない ---
  // 相手の手札の中身とデッキの並びを丸ごと入れ替えても、同じ手を返すこと。
  {
    let s = createInitialState(5003, cardData);
    for (let i = 0; i < 24 && !s.winner; i++) s = reduce(s, chooseCpuAction(s, s.active, aiData));
    const pid = s.active;
    const foe = opponentOf(pid);
    const p = s.players[foe];
    const swapped = {
      ...s,
      players: {
        ...s.players,
        // 枚数は保ったまま、中身を「デッキの別の場所のカード」に差し替える
        [foe]: {
          ...p,
          hand: p.deck.slice(0, p.hand.length),
          deck: [...p.deck.slice(p.hand.length), ...p.hand].reverse(),
        },
        // 自分のデッキの並びも変える（先読みしていないこと）
        [pid]: { ...s.players[pid], deck: s.players[pid].deck.slice().reverse() },
      },
    };
    const a = chooseCpuAction(s, pid, aiData);
    const b = chooseCpuAction(swapped, pid, aiData);
    check(
      '相手の手札・両者のデッキを入れ替えても同じ手を返す（隠し情報を見ていない）',
      JSON.stringify(a) === JSON.stringify(b)
    );
  }

  // --- 4. 一方的に倒せる攻撃を選び、相打ちを避ける ---
  {
    let s = createInitialState(5004, cardData);
    let t;
    t = takeFromDeck(s, 'p1', 'c03'); s = t.s; const mine = t.iid;      // 3/2
    t = takeFromDeck(s, 'p2', 'c01'); s = t.s; const weak = t.iid;      // 1/1 … 一方的に倒せる
    t = takeFromDeck(s, 'p2', 'c03'); s = t.s; const even = t.iid;      // 3/2 … 相打ちになる
    s = place(s, 'p1', slotIndex(0, 0, rules), mine);
    s = place(s, 'p2', slotIndex(0, 0, rules), even);
    s = place(s, 'p2', slotIndex(0, 1, rules), weak);
    s = setHand(s, 'p1', []);          // 召喚の選択肢を消して攻撃だけにする
    s = ready(s, 'p1');

    const a = chooseCpuAction(s, 'p1', aiData);
    check(
      '一方的に倒せる相手を攻撃する（相打ちを選ばない）',
      a.type === 'attack' && a.target.kind === 'unit' && a.target.slot === slotIndex(0, 1, rules)
    );
  }

  // --- 5. 明らかに不利な攻撃はせず、ターンを終える ---
  {
    let s = createInitialState(5005, cardData);
    let t;
    t = takeFromDeck(s, 'p1', 'c01'); s = t.s; const mine = t.iid;      // 1/1
    t = takeFromDeck(s, 'p2', 'c03'); s = t.s; const big = t.iid;       // 3/2
    s = place(s, 'p1', slotIndex(0, 0, rules), mine);
    s = place(s, 'p2', slotIndex(0, 0, rules), big);
    s = setHand(s, 'p1', []);
    s = ready(s, 'p1');
    const a = chooseCpuAction(s, 'p1', aiData);
    check('1/1 で 3/2 に突っ込まない', a.type !== 'attack');
  }

  // --- 6. c06 は右に空きがある枠に置く（不発を避ける） ---
  {
    let s = createInitialState(5006, cardData);
    let t;
    t = takeFromDeck(s, 'p1', 'c06'); s = t.s; const f = t.iid;         // 3pt 2/3
    const pitch = [];
    for (let i = 0; i < 2; i++) { t = takeFromDeck(s, 'p1', 'c02'); s = t.s; pitch.push(t.iid); }
    s = setHand(s, 'p1', [f, ...pitch]);
    s = ready(s, 'p1');

    const a = chooseCpuAction(s, 'p1', aiData);
    const ok = a.type === 'summon' && a.plays[0].iid === f;
    const { col } = ok ? slotRowCol(a.plays[0].slot, rules) : { col: -1 };
    check('c06 を召喚する', ok);
    check('c06 を右に空きがある枠に置く（右端に置かない）', ok && col < rules.board.cols - 1);
    if (ok) {
      const after = reduce(s, a);
      const tokens = after.players.p1.board.filter((i) => i && after.cards[i].token);
      check('c06 のトークンが実際に出る（不発にしない）', tokens.length === 1);
    }
  }

  // --- 7. 空き枠があれば埋めにいく ---
  {
    const s = ready(createInitialState(5007, cardData), 'p1');
    const a = chooseCpuAction(s, 'p1', aiData);
    check('盤面が空なら召喚する', a.type === 'summon');
  }

  // --- 8. CPU 同士で最後まで進行する ---
  {
    let s = createInitialState(5008, cardData);
    let steps = 0;
    while (!s.winner && steps++ < 20000) s = reduce(s, chooseCpuAction(s, s.active, aiData));
    check('CPU 同士の対戦が決着する', s.winner !== null);
    check('決着まで手数が発散しない', steps < 20000);

    // ゾーンの整合。engine のセルフテストが見ている
    // 「自分の墓地に自分のカードが無い」は CPU 同士では成立しない
    // （相手に渡ったカードが相手の場で倒されると、倒した側＝元の持ち主の墓地へ戻るため）。
    // ここでは常に成り立つ性質だけを確かめる。詳細は報告の停止ブロックを参照。
    let dup = 0;
    const zoneOf = new Map();
    for (const pid of PLAYERS) {
      const p = s.players[pid];
      for (const [zone, list] of [
        ['deck', p.deck], ['hand', p.hand], ['grave', p.graveyard], ['board', p.board.filter(Boolean)],
      ]) {
        for (const iid of list) {
          if (zoneOf.has(iid)) dup++;
          zoneOf.set(iid, `${pid}:${zone}`);
        }
      }
    }
    check('同じカードが2つのゾーンに同時に存在しない', dup === 0);
    let controllerOk = true;
    for (const pid of PLAYERS) {
      for (const iid of s.players[pid].graveyard) {
        if (s.cards[iid].controller !== pid) controllerOk = false;
      }
    }
    check('墓地のカードの controller が墓地の持ち主になっている', controllerOk);
  }

  void boardSize;

  console.log(failures === 0 ? `\n${checks} 件すべて成功` : `\n${checks} 件中 ${failures} 件失敗`);
  if (failures > 0) process.exit(1);
}

/**
 * engine.js — 純粋なゲームロジック
 *
 * 【絶対制約】詳細は CLAUDE.md を参照
 *   - DOM / window / document に一切触らない。Node 単体で実行できること
 *   - (state, action) => newState の純粋関数。既存 state を破壊的に変更しない
 *   - action は JSON 化可能なオブジェクトのみ
 *   - 乱数は下記の seeded RNG のみ。Math.random() は禁止
 *   - カードの数値・効果は data/cards.json。ここにベタ書きしない
 *
 * 現状: 雛形。ロジックは未実装。
 * 次の作業単位は docs/NEXT_TASKS.md を参照。
 */

// ---------------------------------------------------------------------------
// seeded RNG
//
// RNG の状態は state の一部として持ち回る。RNG 関数自体は状態を持たない。
// 「同一シード + 同一 action 列 → 同一結果」がこの実装に依存する。
// ---------------------------------------------------------------------------

/**
 * シードから RNG state を作る。
 * @param {number} seed
 * @returns {{s: number}} RNG state
 */
export function createRng(seed) {
  return { s: seed >>> 0 };
}

/**
 * 次の乱数を引く。渡された rng は変更せず、新しい rng を返す。
 * @param {{s: number}} rng
 * @returns {{rng: {s: number}, value: number}} value は [0, 1)
 */
export function nextRandom(rng) {
  // mulberry32
  let t = (rng.s + 0x6d2b79f5) >>> 0;
  let x = t;
  x = Math.imul(x ^ (x >>> 15), x | 1);
  x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
  const value = ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  return { rng: { s: t }, value };
}

/**
 * 配列をシャッフルする。元の配列と rng は変更しない。
 * @param {Array} items
 * @param {{s: number}} rng
 * @returns {{rng: {s: number}, items: Array}}
 */
export function shuffle(items, rng) {
  const out = items.slice();
  let r = rng;
  for (let i = out.length - 1; i > 0; i--) {
    const drawn = nextRandom(r);
    r = drawn.rng;
    const j = Math.floor(drawn.value * (i + 1));
    const tmp = out[i];
    out[i] = out[j];
    out[j] = tmp;
  }
  return { rng: r, items: out };
}

// ---------------------------------------------------------------------------
// state
// ---------------------------------------------------------------------------

/**
 * 初期 state を作る。
 *
 * TODO: state の形を確定する。少なくとも以下を持つ想定。
 *   - players[]: 手札 / デッキ / 墓地 / 持ち駒ゾーン / 盤面スロット / マナ / ネクロマンサー
 *   - turn: 手番プレイヤー / ターン番号 / このターンの蘇生使用済みフラグ
 *   - rng: RNG state
 *   - winner: null | playerId
 *
 * デッキ30枚、初期手札は先攻6枚 / 後攻7枚。
 *
 * @param {number} seed
 * @param {object} cards data/cards.json の内容
 * @returns {object} state
 */
export function createInitialState(seed, cards) {
  throw new Error('createInitialState: 未実装');
}

/**
 * action を1つ適用して新しい state を返す。
 *
 * 【破壊的変更の禁止】state 内のオブジェクト・配列を書き換えず、
 * 変更のあった部分だけ新しく作り直して返すこと。
 *
 * action は JSON 化可能なオブジェクト。想定する type:
 *   { type: 'draft',   pick: 0 }                      めくった2枚から1枚選ぶ
 *   { type: 'play',    cardId: 'c03', slot: 2 }       手札から盤面へ
 *   { type: 'attack',  attackerSlot: 1, targetSlot: 3 }
 *   { type: 'revive',  cardId: 'c07' }                相手の墓地からのみ
 *   { type: 'endTurn' }
 *
 * @param {object} state
 * @param {object} action
 * @returns {object} newState
 */
export function reduce(state, action) {
  throw new Error('reduce: 未実装');
}

/**
 * 特定プレイヤー視点の state を作る。
 *
 * 【必須】相手の手札とデッキの**中身**は必ず落とす。枚数だけ残す。
 * 権威サーバ型のオンライン対戦で、サーバがクライアントへ返す前に必ず通す関数。
 *
 * 落とすもの:
 *   - 相手の手札の中身 → 枚数のみ
 *   - 相手のデッキの中身 → 枚数のみ
 *   - 自分のデッキの中身 → 枚数のみ（自分でも見えてはいけない）
 *   - rng の内部状態 → 丸ごと落とす（先読み防止）
 *
 * 落とさないもの（公開情報）:
 *   - 盤面、両者の墓地、持ち駒ゾーン、マナ、ネクロマンサー
 *
 * @param {object} state
 * @param {string} playerId
 * @returns {object} フィルタ済み state
 */
export function filterStateFor(state, playerId) {
  throw new Error('filterStateFor: 未実装');
}

/**
 * 現在の state でそのプレイヤーが取れる合法な action を列挙する。
 * view はこれを使う。合法性の判定を view 側に書かないこと。
 *
 * @param {object} state
 * @param {string} playerId
 * @returns {Array<object>} action の配列
 */
export function legalActions(state, playerId) {
  throw new Error('legalActions: 未実装');
}

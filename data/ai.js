/**
 * data/ai.js — CPU の性格（v0.3 モック1・CG-021）
 *
 * 【このファイルの中身は素の JSON】
 *   1行目の `var NECRO_AI =` と末尾の module.exports 行以外は触らないこと。
 *   ★ ここはゲームのルールではなく AI の癖なので data/cards.js とは分ける。
 *
 * 【CPU は2種だけ】（CG-021 の指示。強い CPU は作らない）
 *   random … 合法手から一様に選ぶ
 *   greedy … 取れるなら取る。キングを取れるなら最優先で取る。それ以外は random と同じ選び方
 */
var NECRO_AI =
{
  "_note": "選択に使う擬似乱数は、フィルタ済みの state（手数・盤面）と salt から作るハッシュ。AI 自身は乱数の状態を持たないので、同じ state と salt からは常に同じ手が出る。",
  "version": "v0.3-mock1",
  "updated": "2026-10-11",
  "kinds": [
    { "value": "greedy", "label": "貪欲（取れるなら取る）" },
    { "value": "random", "label": "ランダム（合法手から一様）" }
  ],
  "greedy": {
    "_note": "captureOrder: 勝てる攻撃が複数あるとき、取る駒の強さが高い順に選ぶ（同じなら合法手の並び順で先のもの）。takeTies: 同値でぶつかる攻撃（両方山へ還る）を「取る」に含めるか。avoidLosingAttacks: 取れない手を選ぶとき、負ける攻撃を候補から外すか。draftKeep: ドラフトで自分に残す駒（stronger＝強い方、両者同じなら1枚目）。",
    "captureOrder": "strongestTarget",
    "takeTies": false,
    "avoidLosingAttacks": true,
    "avoidTies": true,
    "draftKeep": "stronger"
  }
}
;
if (typeof module !== 'undefined' && module.exports) module.exports = NECRO_AI;

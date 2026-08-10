/**
 * view.js — 描画のみ
 *
 * 【絶対制約】詳細は CLAUDE.md を参照
 *   - engine の state を読んで描画するだけ
 *   - ゲームルールを判定しない。勝敗・合法手・ダメージ計算をここに書かない
 *     （合法手が必要なら engine.legalActions を呼ぶ）
 *   - engine に働きかける唯一の手段は action オブジェクトを渡すこと
 *
 * 現状: 雛形。描画は未実装。
 */

import {
  createInitialState,
  reduce,
  filterStateFor,
  legalActions,
} from './engine.js';

/** このクライアントが操作するプレイヤー */
let viewerId = null;

/** engine が持つ唯一の state（将来はサーバ側に置く） */
let state = null;

/**
 * カード定義を読み込む。数値・効果は必ず data/cards.json から取る。
 * @returns {Promise<object>}
 */
async function loadCards() {
  const res = await fetch('./data/cards.json');
  return res.json();
}

/**
 * action を engine に渡し、返ってきた新しい state で描画し直す。
 * ここでは合法性を判定しない。engine が拒否したらそれに従う。
 * @param {object} action JSON 化可能な action オブジェクト
 */
function dispatch(action) {
  state = reduce(state, action);
  render();
}

/**
 * 視点フィルタを通した state を描画する。
 * 生の state を直接描画しないこと。
 */
function render() {
  const visible = filterStateFor(state, viewerId);
  // TODO: visible を DOM に描画する
  //   - 盤面スロット
  //   - 自分の手札 / 相手の手札は枚数のみ
  //   - 両者の墓地
  //   - 持ち駒ゾーン（公開）
  //   - マナ
  //   - ネクロマンサー
  //   - ドラフト（2枚めくり1枚選択）の選択 UI
  // クリック等のハンドラは dispatch({...}) を呼ぶだけにする
  void visible;
  void legalActions;
}

async function main() {
  const cards = await loadCards();
  viewerId = 'p1';
  state = createInitialState(/* seed */ 1, cards);
  render();
}

main();

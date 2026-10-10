/**
 * data/cards.js — v0.3 モック1 の駒・盤・ルールフラグ（CG-021）
 *
 * 【このファイルの中身は素の JSON】
 *   1行目の `var NECRO_CARDS =` と末尾の module.exports 行以外は触らないこと。
 *   バランス調整・ルールの切り替えはこのファイルの編集だけで完結する（JS 側にベタ書きしない）。
 *
 * 【なぜ .json ではなく .js なのか】
 *   file:// で開いたページからは fetch() が使えないため（CG-008 を v0.3 でも踏襲）。
 *   <script> タグなら file:// でも読める。データの正本はここ一箇所だけ。
 *
 * 【仕様の正本】Notion CURRENT_SPEC の「v0.3 モック1 仕様」。
 *   ★ v0.2 の数値・規則（ピッチ・墓地・6スロット・カード8種・体力12）は持ち込まない。
 */
var NECRO_CARDS =
{
  "_note": "v0.3 モック1（核だけ）。駒は「移動型・強さ・配置範囲」の3つだけを持つ。能力はない。★ 数値はすべて仕様の仮の値（調整前提）。",
  "version": "v0.3-mock1",
  "updated": "2026-10-11",

  "board": {
    "_note": "7×7。列は A〜G、行は 1〜7。先手(p1)は行7の側、後手(p2)は行1の側。",
    "cols": 7,
    "rows": 7,
    "colNames": ["A", "B", "C", "D", "E", "F", "G"],
    "homeRow": { "p1": 7, "p2": 1 }
  },

  "moveTypes": {
    "_note": "動きの形はチェスと同じ。dy は持ち主から見た「前」が +1。slide=true は何マスでも進める（距離の上限なし・他の駒は飛び越えられない）。jump=true は途中のマスを見ない（ナイトだけ）。capture を持つ型は、取るときだけ capture の方向を使い、move の方向では取れない（ポーン）。",
    "pawn":   { "name": "ポーン",     "move": [[0, 1]], "capture": [[-1, 1], [1, 1]], "slide": false, "jump": false },
    "knight": { "name": "ナイト",     "move": [[1, 2], [2, 1], [2, -1], [1, -2], [-1, -2], [-2, -1], [-2, 1], [-1, 2]], "slide": false, "jump": true },
    "bishop": { "name": "ビショップ", "move": [[1, 1], [1, -1], [-1, 1], [-1, -1]], "slide": true, "jump": false },
    "rook":   { "name": "ルーク",     "move": [[0, 1], [0, -1], [1, 0], [-1, 0]], "slide": true, "jump": false },
    "queen":  { "name": "クイーン",   "move": [[0, 1], [0, -1], [1, 0], [-1, 0], [1, 1], [1, -1], [-1, 1], [-1, -1]], "slide": true, "jump": false },
    "king":   { "name": "キング",     "move": [[0, 1], [0, -1], [1, 0], [-1, 0], [1, 1], [1, -1], [-1, 1], [-1, -1]], "slide": false, "jump": false }
  },

  "pieces": {
    "_note": "両者同じ構成・山16枚。range は配置範囲（0＝最奥列のみ、1＝奥の2列、2＝奥の3列）。symbol / short は表示用。★ 調整前提の仮の数値。",
    "list": [
      { "kind": "pawn",   "move": "pawn",   "strength": 1, "range": 2, "count": 8, "short": "P", "symbol": "♟" },
      { "kind": "knight", "move": "knight", "strength": 3, "range": 1, "count": 3, "short": "N", "symbol": "♞" },
      { "kind": "bishop", "move": "bishop", "strength": 3, "range": 1, "count": 2, "short": "B", "symbol": "♝" },
      { "kind": "rook",   "move": "rook",   "strength": 4, "range": 0, "count": 2, "short": "R", "symbol": "♜" },
      { "kind": "queen",  "move": "queen",  "strength": 5, "range": 0, "count": 1, "short": "Q", "symbol": "♛" }
    ]
  },

  "king": {
    "_note": "キングは山に入らない。最奥列の中央に置いて始める。寝返らない。倒されたら負け。",
    "kind": "king",
    "move": "king",
    "strength": 3,
    "start": { "p1": "D7", "p2": "D1" },
    "short": "K",
    "symbol": "♚"
  },

  "rules": {
    "_note": "仕様で「フラグ」「仮置き」とされているもの、および仕様の曖昧な点に既定の振る舞いを決めたもの（SESSION_STATE の判断待ちに問いを記載）。デバッグパネルから切り替えられる。",
    "initialHand": 3,
    "drawMode": "turnStart",
    "winnerLosesStrength": false,
    "defectorPlacement": "king",
    "defeatsToReturn": 2,
    "draftSize": 2,
    "maxPlies": 200,
    "kingTie": "kingFalls",
    "resetDefeatsOnReturn": true
  },

  "flags": {
    "_note": "デバッグパネルの項目。default は上の rules の値と同じであること（engine のセルフテストが照合する）。source=spec は仕様が明示したフラグ、source=ambiguity は仕様の曖昧な点に既定を決めてフラグ化したもの。",
    "list": [
      { "key": "winnerLosesStrength", "label": "勝った側の強さ", "source": "spec",
        "choices": [ { "value": false, "label": "減らない" }, { "value": true, "label": "負けた側の分だけ減る" } ] },
      { "key": "defectorPlacement", "label": "寝返りの置き場所", "source": "spec",
        "choices": [ { "value": "king", "label": "キングの周囲" }, { "value": "winner", "label": "勝った駒の周囲" } ] },
      { "key": "defeatsToReturn", "label": "N（山へ還る撃破回数）", "source": "spec",
        "choices": [ { "value": 1, "label": "1" }, { "value": 2, "label": "2" }, { "value": 3, "label": "3" }, { "value": 4, "label": "4" } ] },
      { "key": "drawMode", "label": "引き方", "source": "spec",
        "choices": [ { "value": "turnStart", "label": "手番の開始時" }, { "value": "action", "label": "引くことを1行動にする" } ] },
      { "key": "kingTie", "label": "キングが同値でぶつかったとき", "source": "ambiguity",
        "choices": [ { "value": "kingFalls", "label": "キングは倒れる（決着）" }, { "value": "kingSurvives", "label": "キングは残り、相手の駒だけ山へ" } ] },
      { "key": "resetDefeatsOnReturn", "label": "山へ還ったとき倒された回数を", "source": "ambiguity",
        "choices": [ { "value": true, "label": "0 に戻す" }, { "value": false, "label": "持ち越す" } ] }
    ]
  }
}
;
if (typeof module !== 'undefined' && module.exports) module.exports = NECRO_CARDS;

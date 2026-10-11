/**
 * data/cards.js — v0.3 の駒・盤・能力・ルールフラグ（CG-021・CG-023）
 *
 * 【このファイルの中身は素の JSON】
 *   1行目の `var NECRO_CARDS =` と末尾の module.exports 行以外は触らないこと。
 *   バランス調整・ルールの切り替えはこのファイルの編集だけで完結する（JS 側にベタ書きしない）。
 *
 * 【なぜ .json ではなく .js なのか】
 *   file:// で開いたページからは fetch() が使えないため（CG-008 を v0.3 でも踏襲）。
 *   <script> タグなら file:// でも読める。データの正本はここ一箇所だけ。
 *
 * 【仕様の正本】Notion CURRENT_SPEC の「v0.3 モック1 仕様」と「v0.3 モック2 追加仕様」。
 *   ★ v0.2 の数値・規則（ピッチ・墓地・6スロット・カード8種・体力12）は持ち込まない。
 *
 * 【能力の足し方】（CG-023）
 *   abilities に1行足して、駒の ability にその id を書く。発火点（trigger）と効果の型（effect）が
 *   既存のものなら engine は触らなくてよい。新しい効果の型だけは engine の EFFECTS 表に1つ足す。
 */
var NECRO_CARDS =
{
  "_note": "v0.3 モック2（モック1の核＋能力8種と実際の強さ）。駒は「移動型・強さ・配置範囲・能力」を持つ。モック1の駒構成も pieceSets に残してある。★ 数値はすべて仕様の仮の値（調整前提）。",
  "version": "v0.3-mock2",
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

  "pieceSets": {
    "_note": "駒構成。rules.pieceSet で選ぶ（既定 mock2）。両者同じ構成・山16枚。kind は構成の中で一意の id。move は moveTypes のキー。range は配置範囲（0＝最奥列のみ、1＝奥の2列、2＝奥の3列）。ability は abilities のキー（null＝能力なし。1枚に最大1つ）。symbol / short は表示用。★ 数値はすべて仕様の仮の値（調整前提）。",
    "mock2": {
      "label": "モック2（能力8種）",
      "list": [
        { "kind": "pawn",             "move": "pawn",   "strength": 1, "range": 2, "ability": null,         "count": 5, "short": "P", "symbol": "♟" },
        { "kind": "pawnTriumph",      "move": "pawn",   "strength": 1, "range": 1, "ability": "triumph",    "count": 2, "short": "P", "symbol": "♟" },
        { "kind": "pawnLastWill",     "move": "pawn",   "strength": 1, "range": 2, "ability": "lastWill",   "count": 1, "short": "P", "symbol": "♟" },
        { "kind": "knightPhalanx",    "move": "knight", "strength": 2, "range": 1, "ability": "phalanx",    "count": 2, "short": "N", "symbol": "♞" },
        { "kind": "knightTraitor",    "move": "knight", "strength": 3, "range": 1, "ability": "traitor",    "count": 1, "short": "N", "symbol": "♞" },
        { "kind": "bishopIntimidate", "move": "bishop", "strength": 2, "range": 1, "ability": "intimidate", "count": 2, "short": "B", "symbol": "♝" },
        { "kind": "rookPush",         "move": "rook",   "strength": 3, "range": 0, "ability": "push",       "count": 1, "short": "R", "symbol": "♜" },
        { "kind": "rookImmovable",    "move": "rook",   "strength": 4, "range": 0, "ability": "immovable",  "count": 1, "short": "R", "symbol": "♜" },
        { "kind": "queenInspire",     "move": "queen",  "strength": 4, "range": 0, "ability": "inspire",    "count": 1, "short": "Q", "symbol": "♛" }
      ]
    },
    "mock1": {
      "label": "モック1（能力なし）",
      "list": [
        { "kind": "pawn",   "move": "pawn",   "strength": 1, "range": 2, "ability": null, "count": 8, "short": "P", "symbol": "♟" },
        { "kind": "knight", "move": "knight", "strength": 3, "range": 1, "ability": null, "count": 3, "short": "N", "symbol": "♞" },
        { "kind": "bishop", "move": "bishop", "strength": 3, "range": 1, "ability": null, "count": 2, "short": "B", "symbol": "♝" },
        { "kind": "rook",   "move": "rook",   "strength": 4, "range": 0, "ability": null, "count": 2, "short": "R", "symbol": "♜" },
        { "kind": "queen",  "move": "queen",  "strength": 5, "range": 0, "ability": null, "count": 1, "short": "Q", "symbol": "♛" }
      ]
    }
  },

  "areas": {
    "_note": "能力の範囲（効果の出どころのマスからの相対位置 [列, 行]）。around8＝周囲8マス、orthogonal1＝縦横1マス。",
    "around8": [[-1, -1], [0, -1], [1, -1], [-1, 0], [1, 0], [-1, 1], [0, 1], [1, 1]],
    "orthogonal1": [[0, -1], [-1, 0], [1, 0], [0, 1]]
  },

  "abilities": {
    "_note": "能力の定義（CG-023・モック2の8種）。trigger＝発火点：static（常時）／onWin（勝利時：攻撃でも防御でも）／onDefect（寝返り時）／onReturn（山へ還るとき）／onAttackWin（攻めて勝ったとき）。effect＝効果の型（engine の EFFECTS 表のキー）。aura：area の範囲の affects（allies＝自分以外の味方／enemies＝敵）の実際の強さに amount を足す。gainBase：自分の基礎の強さに amount。areaBase：at（defeatedSquare＝倒されたマス）の area の範囲にいる affects（formerAllies＝寝返る直前の味方）の基礎の強さに amount。ownerDraws：元の持ち主が自分の山から count 枚引く。push：倒した駒のいたマスの、攻めた向きのもう1つ先の駒を1マス押す。immovable：押し出しで押されない。short は駒に出す1文字。",
    "inspire":    { "name": "鼓舞",     "short": "鼓", "trigger": "static",      "effect": "aura",       "area": "around8",     "affects": "allies",  "amount": 1,  "text": "周囲8マスの味方の駒の強さ+1（自分は含まない）" },
    "phalanx":    { "name": "槍衾",     "short": "槍", "trigger": "static",      "effect": "aura",       "area": "orthogonal1", "affects": "allies",  "amount": 2,  "text": "縦横1マスの味方の駒の強さ+2（自分は含まない）" },
    "intimidate": { "name": "威圧",     "short": "威", "trigger": "static",      "effect": "aura",       "area": "around8",     "affects": "enemies", "amount": -1, "text": "周囲8マスの敵の駒の強さ-1" },
    "triumph":    { "name": "凱歌",     "short": "凱", "trigger": "onWin",       "effect": "gainBase",   "amount": 1,  "text": "【勝利時】戦闘に勝つたび（攻撃でも防御でも）自分の基礎の強さ+1" },
    "traitor":    { "name": "裏切り者", "short": "裏", "trigger": "onDefect",    "effect": "areaBase",   "at": "defeatedSquare", "area": "around8", "affects": "formerAllies", "amount": -1, "text": "【寝返り時】倒されたマスの周囲8マスにいる元の味方の駒の基礎の強さ-1" },
    "lastWill":   { "name": "遺言",     "short": "遺", "trigger": "onReturn",    "effect": "ownerDraws", "count": 1,   "text": "【山へ還るとき】元の持ち主が自分の山から1枚引く" },
    "push":       { "name": "押し出し", "short": "押", "trigger": "onAttackWin", "effect": "push",       "text": "【攻めて勝ったとき】倒した駒のいたマスの、攻めた向きのもう1つ先にいる駒（敵味方を問わない）を1マス押す" },
    "immovable":  { "name": "不動",     "short": "不", "trigger": "static",      "effect": "immovable",  "text": "押し出しで押されない" }
  },

  "king": {
    "_note": "キングは山に入らない。最奥列の中央に置いて始める。寝返らない。倒されたら負け。能力はない（モック2）が、常時の効果は受ける。",
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
    "resetDefeatsOnReturn": true,
    "firstTurnDraw": true,
    "draftSide": "controller",
    "pieceSet": "mock2",
    "kingPushable": false,
    "onReturnTiming": "afterReturn",
    "traitorOnNoSpace": false
  },

  "flags": {
    "_note": "デバッグパネルの項目。default は上の rules の値と同じであること（engine のセルフテストが照合する）。source=spec は仕様が明示したフラグ、source=ambiguity は仕様の曖昧な点に既定を決めてフラグ化したもの、source=tuning は数値の調整用（kingStrength の既定は rules ではなく king.strength。CG-022）。",
    "list": [
      { "key": "pieceSet", "label": "駒構成", "source": "spec",
        "choices": [ { "value": "mock2", "label": "モック2（能力8種）" }, { "value": "mock1", "label": "モック1（能力なし）" } ] },
      { "key": "kingStrength", "label": "キングの強さ", "source": "tuning",
        "choices": [ { "value": 3, "label": "3" }, { "value": 6, "label": "6" }, { "value": 8, "label": "8" }, { "value": 10, "label": "10" } ] },
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
        "choices": [ { "value": true, "label": "0 に戻す" }, { "value": false, "label": "持ち越す" } ] },
      { "key": "firstTurnDraw", "label": "先手の最初の手番の開始時に", "source": "ambiguity",
        "choices": [ { "value": true, "label": "引く（文言どおり）" }, { "value": false, "label": "引かない" } ] },
      { "key": "draftSide", "label": "ドラフトするのは", "source": "ambiguity",
        "choices": [ { "value": "controller", "label": "倒された時点の持ち主" }, { "value": "owner", "label": "倒された駒の元の持ち主" } ] },
      { "key": "kingPushable", "label": "キングが押し出しで", "source": "spec",
        "choices": [ { "value": false, "label": "押されない" }, { "value": true, "label": "押される" } ] },
      { "key": "onReturnTiming", "label": "【山へ還るとき】（遺言）の発動は", "source": "ambiguity",
        "choices": [ { "value": "afterReturn", "label": "山の底へ入れた後" }, { "value": "beforeReturn", "label": "山の底へ入れる前" } ] },
      { "key": "traitorOnNoSpace", "label": "置き場所がなく山へ還る裏切り者は", "source": "ambiguity",
        "choices": [ { "value": false, "label": "発動しない（寝返っていない）" }, { "value": true, "label": "発動する" } ] }
    ]
  }
}
;
if (typeof module !== 'undefined' && module.exports) module.exports = NECRO_CARDS;

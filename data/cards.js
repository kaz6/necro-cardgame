/**
 * data/cards.js — カード定義 + ルールフラグ
 *
 * 【このファイルの中身は素の JSON】
 *   1行目の `var NECRO_CARDS =` と末尾の module.exports 行以外は触らないこと。
 *   バランス調整はこのファイルの数値だけを編集すれば完結する（JS 側にベタ書きしない）。
 *
 * 【なぜ .json ではなく .js なのか】
 *   file:// で開いたページからは fetch() が使えないため（CG-008）。
 *   <script> タグなら file:// でも読める。データの正本はここ一箇所だけで、
 *   .json との二重管理はしない。Node からは require で同じものを読む。
 */
var NECRO_CARDS =
{
  "_note": "カードの数値・効果・ルールフラグはすべてここに置く。JS にベタ書き禁止。バランス調整はこのファイルの編集だけで完結すること。",
  "_naming": "★カード名は「モンスターA〜H」で固定。本編未完成の企画のキャラに本作が先に名前を与えると本編側の設計が縛られるため、プロト段階では固有名を付けない。良かれと思って命名しないこと。詳細は docs/DECISION_LOG.md「登場カードの供給源」および docs/REJECTED.md を参照。",
  "version": "0.2",
  "updated": "2026-08-11",

  "rules": {
    "_note": "未確定・仮ルールはここでフラグ化する。engine.js は必ずこの値を読む。",
    "board": {
      "cols": 3,
      "rows": 2,
      "_slotIndex": "slot = row * cols + col。row 0 = 前列、row 1 = 後列"
    },
    "openingHand": { "first": 6, "second": 7 },
    "drawPerTurn": 3,
    "_drawPerTurn": "毎ターンのドロー枚数。CG-010 で 2 → 3。理由: 作者のプレイテストで『手札消費が激しく、カードをコストとしてしか消費しない』体感が出たため、手札の供給側で緩和する。ピッチの 1:1 変換（コスト＝捨てる枚数）は核の再現に必要なので変えていない。2 に戻せば CG-009 までの挙動に戻る（engine は必ずこの値を読む）。ピッチを1枚固定にする案は却下済み（docs/REJECTED.md）。",
    "firstPlayerDrawsOnTurn1": true,
    "deckOutLoses": false,

    "summoningSickness": false,
    "attacksPerUnitPerTurn": 1,

    "repositionCost": 0,
    "repositionPerTurn": null,

    "necromancerCanAttack": false,
    "necromancerProtectedWhileBoardOccupied": true,

    "backRowProtectedByFront": true,

    "summonSourcesSnapshotBeforePitch": true,
    "_summonSourcesSnapshotBeforePitch": "true のとき、召喚元の墓地は「ピッチで捨てる前」の状態で確定する。false にすると、捨てた自分のカードを同一 action 内で即座に召喚し直せてしまう（実質ノーコスト召喚）。",

    "graveyardSummonBuffer": 0,
    "_graveyardSummonBuffer": "墓地に入ったカードが召喚できるようになるまでに必要な経過ターン数（1ターン＝片方の手番）。state.turn - enteredGraveyardTurn >= この値、で判定する。0 = 即座に召喚できる（既定・CG-016）。1 = 墓地に入ったその手番中は召喚できない（同じ手番で倒して出し直す動きだけを止める）。2 = 墓地の持ち主が自分の手番を1回またぐまで召喚できない（先攻が1ターン目にピッチしたカードを、後攻が2ターン目に使えなくなる）。CG-011 で 2 を既定にしたが、CG-016 の裁定（要裁定4＝A）で既定を 0 に確定した。機能そのものは残してあり、デバッグパネルから 2 に戻して比較できる。理由は docs/DECISION_LOG.md を参照。",

    "pitchCarryover": false,
    "_pitchCarryover": "余ったピッチ pt をターン内で持ち越すか（CG-015）。false = 召喚を確定するたびに余りは消える（従来の挙動・既定）。true = 余りは players[].pitchCredit に積まれ、同じ手番内の次の召喚の支払いに使える。ターン終了時に消える。呪い（c08）の +1pt は従来どおり『墓地から出す召喚』の確定時に判定され、持ち越した pt でも支払える（pt の出所は問わない）。既定を false にした理由: これまでの測定の基準（CG-001〜CG-014）を変えないため。デバッグパネルから切り替え可能。",

    "abilities": {
      "_note": "能力テキストに書かれていない部分の解釈を、CG-005 でフラグ化したもの。engine.js は必ずこの値を読む。裁定が変わったらここを書き換える。",

      "deathRetreatNoRoom": "toGraveyard",
      "_deathRetreatNoRoom": "c05『倒されたとき 1/1 になって後列へ移動する』で、後列に空きがないときの挙動。'toGraveyard' = 不発。通常どおり相手の墓地へ行く（既定）。'anyEmptySlot' = 前列も含めた空き枠へ退く。",

      "deathRetreatSlotOrder": "sameColumnFirst",
      "_deathRetreatSlotOrder": "後列の空きが複数あるときの行き先。'sameColumnFirst' = 同じ列の後列を優先し、埋まっていれば後列を左から（既定）。'leftmost' = 常に後列を左から。",

      "killTriggerOnCounterattack": true,
      "_killTriggerOnCounterattack": "c07『相手のカードを倒したとき』が、防御側として反撃で倒した場合にも発動するか。true = 発動する（既定）。false = 自分から攻撃して倒したときのみ。",

      "curseStacking": "add",
      "_curseStacking": "c08 の呪いが相手の墓地に複数あるときの積み方。'add' = 加算し、その召喚でまとめて全部発動する（既定）。'first' = 何枚あっても1枚分だけ発動する。"
    },

    "summonSource": "ownGraveyard",
    "_summonSource": "召喚元の墓地。既定は 'ownGraveyard'（2026-08-11 訂正で確定）。自分の墓地にあるのは①自分が倒した相手のカード②相手が支払いで捨てたカードの2つだけなので、墓地からの召喚は常に「奪ったものを使役する」行為になる。'opponentGraveyard' にすると一貫法則（自分の手を離れたカードはすべて相手の資源になる）が壊れるため使わない。切り替え機構は撤回前の挙動を再現する目的でのみ残してある。"
  },

  "necromancer": {
    "id": "necro",
    "name": "ネクロマンサー",
    "cost": 0,
    "attack": 0,
    "health": 12,
    "ability": null
  },

  "cards": [
    {
      "id": "c01",
      "name": "モンスターA",
      "cost": 1,
      "attack": 1,
      "health": 1,
      "ability": null,
      "implemented": true
    },
    {
      "id": "c02",
      "name": "モンスターB",
      "cost": 2,
      "attack": 1,
      "health": 3,
      "ability": null,
      "implemented": true
    },
    {
      "id": "c03",
      "name": "モンスターC",
      "cost": 3,
      "attack": 3,
      "health": 2,
      "ability": null,
      "implemented": true
    },
    {
      "id": "c04",
      "name": "モンスターD",
      "cost": 5,
      "attack": 5,
      "health": 4,
      "ability": null,
      "implemented": true
    },

    {
      "id": "c05",
      "name": "モンスターE",
      "cost": 2,
      "attack": 1,
      "health": 2,
      "ability": {
        "trigger": "onDeath",
        "effect": "retreatToBackRow",
        "params": { "attack": 1, "health": 1 },
        "text": "倒されたとき、1/1 になって後列へ移動する。後列に空きがなければ、通常どおり相手の墓地へ行く。移動したあとで再度倒されたときは、通常どおり相手の墓地へ行く。"
      },
      "implemented": true
    },
    {
      "id": "c06",
      "name": "モンスターF",
      "cost": 3,
      "attack": 2,
      "health": 3,
      "ability": {
        "trigger": "onEnter",
        "effect": "spawnTokenRight",
        "params": { "tokenId": "t01" },
        "text": "場に出たとき、右の空き枠に 1/1 のトークンを出す。右が埋まっている場合と、右端に出た場合は何も起きない。"
      },
      "implemented": true
    },
    {
      "id": "c07",
      "name": "モンスターG",
      "cost": 4,
      "attack": 4,
      "health": 2,
      "ability": {
        "trigger": "onKill",
        "effect": "millOpponentDeck",
        "params": { "count": 1 },
        "text": "相手のカードを倒したとき、相手のデッキの一番上1枚を自分の墓地へ送る。相手のデッキが空なら何も起きない。ネクロマンサーを倒した場合は勝敗が決するので解決しない。"
      },
      "implemented": true
    },
    {
      "id": "c08",
      "name": "モンスターH",
      "cost": 4,
      "attack": 2,
      "health": 5,
      "ability": {
        "trigger": "whileInOpponentGraveyard",
        "effect": "graveyardSummonTax",
        "params": { "amount": 1 },
        "text": "呪い。このカードが相手の墓地にある間、相手が墓地から召喚する最初の1回に、支払いポイントを1多く必要とする。「最初の1回」はこのカードが相手の墓地に入ってから数える。一度発動したら、墓地に留まっていても再発動しない。"
      },
      "implemented": true
    }
  ],

  "tokens": {
    "_note": "能力で生成されるカード。デッキには入らないので deck.lists には現れない。",
    "_onDeath": "倒されたときの行き先。カード定義側のフラグで、engine は defs[cardId].onDeath を読むだけ（トークンかどうかで分岐しない）。'vanish' = 墓地へ行かずに消滅する（既定・CG-007 の裁定A）。'toGraveyard' = 通常どおり倒した側の墓地へ行く（＝CG-006 までの挙動。省略時もこちら）。",
    "_onDeathReason": "コスト0のため墓地から 0pt で再召喚でき、CG-006 の CPU 同士1000戦では全召喚の 91.7% がこれになり、1000戦中150戦が未決着になった。トークンは手札に存在しないカードなので「自分の手を離れたカードは相手の資源になる」の対象外（法則の例外ではなく、そもそも手札を離れていない）。",
    "list": [
      {
        "id": "t01",
        "name": "トークン",
        "cost": 0,
        "attack": 1,
        "health": 1,
        "ability": null,
        "token": true,
        "onDeath": "vanish",
        "implemented": true
      }
    ]
  },

  "deck": {
    "_note": "デッキ枚数は未確定（試合の長さの調整弁）。現状は仮の30枚。両プレイヤーとも default を使う。",
    "_c08": "呪い（c08）は指示により2枚投入。減らした1枚は c07 に回してある（c07・c08 とも コスト4 なので、デッキのコスト構成比が CG-001 の測定時とまったく同じに保たれる＝前後比較でデッキ側の母数が動かない）。",
    "size": 30,
    "lists": {
      "default": [
        { "cardId": "c01", "copies": 5 },
        { "cardId": "c02", "copies": 5 },
        { "cardId": "c03", "copies": 4 },
        { "cardId": "c04", "copies": 2 },
        { "cardId": "c05", "copies": 4 },
        { "cardId": "c06", "copies": 4 },
        { "cardId": "c07", "copies": 4 },
        { "cardId": "c08", "copies": 2 }
      ]
    }
  }
};

if (typeof module !== "undefined" && module.exports) module.exports = NECRO_CARDS;

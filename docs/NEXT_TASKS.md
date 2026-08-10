# NEXT_TASKS

次の作業単位。上から順に着手する。
進捗の全体像は `SESSION_STATE.md` を参照。

---

## 1. data/cards.json — カード8種の定義

- [ ] スキーマを確定する（id / name / cost / attack / health / ability など）
- [ ] 能力なし4種を定義する
- [ ] 呪い1種を定義する（墓地常在型。自分の墓地にある間、相手の蘇生に追加コスト1枚）
- [ ] 有効効果3種を定義する ※ **効果テキストは未確定。人間の判断待ち**
- [ ] ネクロマンサーの定義を入れる（各プレイヤー1枚・常時場・公開・出し入れ不可）

制約: 数値・効果はすべて JSON に置く。JS にベタ書きしない。

---

## 2. js/engine.js — 1ターン処理

- [ ] state の形を決める（盤面 / 手札 / デッキ / 墓地 / 持ち駒ゾーン / マナ / RNG state）
- [ ] seeded RNG を実装する（`Math.random()` 禁止。RNG 状態は state に持つ）
- [ ] `createInitialState(seed, deckLists)` — デッキ30枚、初手 先攻6/後攻7
- [ ] `reduce(state, action) => newState` — 破壊的変更なし
- [ ] `filterStateFor(state, playerId)` — 相手の手札とデッキの中身を必ず落とす
- [ ] action の型を確定する（`play` / `draft` / `attack` / `revive` / `endTurn`）
- [ ] ドロー処理（2枚めくり1枚選択、残り1枚は自分の墓地へ）
- [ ] 蘇生処理（相手の墓地からのみ・ノーコスト・1ターン1枚・デッキ上1枚を自分の墓地へ）
- [ ] 敗北判定（ネクロマンサー撃破）

検証: `node js/engine.js` が単体で通ること。同一シード + 同一 action 列で同一結果。

---

## 3. js/view.js — 描画

- [ ] `filterStateFor` を通した state を受け取って描画する
- [ ] action を組み立てて engine に渡す（view からルール判定をしない）

---

## 4. 未確定項目の解消

`SESSION_STATE.md` の「未確定項目」参照。実装より先に人間の判断が必要。

- [ ] 能力持ち3種の具体的効果テキスト
- [ ] マナカーブ（増加量・コスト分布）
- [ ] 呪いのノイズ判定（デッキ30枚中2枚が事故要因になりすぎないか）

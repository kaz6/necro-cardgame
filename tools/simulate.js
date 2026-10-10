/**
 * tools/simulate.js — 自動対戦を1回まわして要約を出す（v0.3 モック1・CG-021）
 *
 *   node tools/simulate.js
 *   SIM_GAMES=500 SIM_SEED=1000 SIM_P1=greedy SIM_P2=random node tools/simulate.js
 *   SIM_RULES='{"winnerLosesStrength":true}' node tools/simulate.js
 *
 * 書き出しはしない（docs/research へ書くのは tools/compare_v03.js）。
 */
const H = require('./harness.js');

const games = Number(process.env.SIM_GAMES || 500);
const seed = Number(process.env.SIM_SEED || 1000);
const kinds = { p1: process.env.SIM_P1 || 'greedy', p2: process.env.SIM_P2 || 'greedy' };
const overrides = process.env.SIM_RULES ? JSON.parse(process.env.SIM_RULES) : {};
const list = H.runBatch({ seeds: H.seedRange(seed, games), kinds, overrides });
const s = H.summarize(list, { ...H.cardData.rules, ...overrides }.maxPlies);
console.log(`シード ${seed}〜${seed + games - 1}（${games}戦）・先手 ${kinds.p1}・後手 ${kinds.p2}・上書き ${JSON.stringify(overrides)}`);
console.log(`決着まで平均 ${s.meanPlies.toFixed(1)} 手（中央値 ${s.medianPlies}・10%点 ${s.p10}・90%点 ${s.p90}）`);
console.log(`先手 ${(s.p1Rate * 100).toFixed(1)}%・後手 ${((s.p2 / s.n) * 100).toFixed(1)}%・引き分け ${(s.drawRate * 100).toFixed(1)}%`);
console.log('試合あたり', Object.entries(s.perGame).map(([k, v]) => `${k} ${v.toFixed(2)}`).join('・'));

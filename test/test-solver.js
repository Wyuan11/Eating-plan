'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { solve, summarize, toFen } = require('../server/solver');
const menuPath = process.argv[2];
if (!menuPath) throw new Error('用法: node test-solver.js <menu.json路径>');
const menu = JSON.parse(fs.readFileSync(menuPath, 'utf8'));
function verify(result) {
  assert.equal(result.success, true);
  const price = result.items.reduce((s, i) => s + i.price * i.quantity, 0);
  const cal = result.items.reduce((s, i) => s + i.calorie * i.quantity, 0);
  assert.equal(toFen(price), toFen(result.plan.total_price));
  assert.equal(cal, result.plan.total_calorie);
  assert.ok(result.items.every(i => i.calorie !== null && i.calorie_source === 'official'));
  assert.ok(result.items.filter(i => i.category === '主食').reduce((s, i) => s + i.quantity, 0) >= result.constraints.people);
  assert.ok(result.plan.total_price <= result.constraints.budget);
  if (result.constraints.calorie_limit != null) assert.ok(result.plan.total_calorie <= result.constraints.calorie_limit);
}
const main = solve(menu.items, { storeCode: menu.store.code, storeName: menu.store.name, budget: 60, calorie_limit: 1200, people: 2, excluded: ['辣'] }, { maxNodes: 200000 });
verify(main);
assert.ok(main.items.some(i => i.quantity > 1) || main.items.length >= 2);
const noBudget = solve(menu.items, { budget: 15, people: 3, excluded: [] });
assert.equal(noBudget.success, false); assert.ok(noBudget.conflict); assert.match(noBudget.hint, /预算|人数/);
const noCal = solve(menu.items, { budget: 80, calorie_limit: 100, people: 2, excluded: [] });
assert.equal(noCal.success, false); assert.ok(noCal.conflict); assert.match(noCal.hint, /热量|预算/);
const noLimit = solve(menu.items, { budget: 40, people: 1, excluded: [] });
verify(noLimit); assert.equal(noLimit.plan.calorie_usage, '—');
const repeatItem = menu.items.find(i => i.kind === 'single' && i.category === '主食' && i.calorie_source === 'official');
const repeated = summarize([repeatItem, repeatItem], { budget: 100, calorie_limit: null });
assert.equal(repeated.list.find(i => i.code === repeatItem.code).quantity, 2);
assert.equal(repeated.plan.total_price, repeatItem.price * 2);
const food = (code, price, calorie) => ({ code, name: code, price, original_price: price, calorie, calorie_source: 'official', kind: 'single', category: '主食', available: true, tags: [], nutrition: { protein: 1, fat: 1, carbohydrate: 1, sodium: 1, calcium: 1 } });
const only = solve([food('A', 0.1, 100)], { budget: 0.3, people: 3 });
verify(only); assert.equal(only.items[0].quantity, 3); assert.equal(only.plan.total_price, 0.3);
assert.equal(solve([food('A', 0.1, 100)], { budget: 0.29, people: 3 }).success, false);
assert.ok(solve([food('A', 1, null)], { budget: 10 }).error);
const unknown = { ...food('U', 1, null), calorie_source: 'unknown' };
const zero = { ...food('Z', 1, 0), category: '饮品' };
const trustedOnly = solve([food('A', 1, 100), unknown, zero], { budget: 4 });
verify(trustedOnly); assert.ok(!trustedOnly.items.some(i => i.code === 'U'));
assert.equal(solve([food('A', 1, 100)], { budget: 4, people: 1.5 }).error.code, 'BAD_REQUEST');
assert.equal(solve([food('A', 1, 100)], { budget: 4 }, { maxNodes: 1 }).error.code, 'INTERNAL_ERROR');
// Joint conflict: cheap high-calorie vs expensive low-calorie main.
const jointMenu = [food('A', 10, 800), food('B', 30, 300)];
const joint = solve(jointMenu, { budget: 20, calorie_limit: 500 });
assert.equal(joint.success, false); assert.equal(joint.conflict, '预算 vs 热量');
assert.match(joint.hint, /30 元/); assert.match(joint.hint, /800 kcal/);
verify(solve(jointMenu, { budget: 30, calorie_limit: 500 }));
verify(solve(jointMenu, { budget: 20, calorie_limit: 800 }));
const shuffled = solve([...menu.items].reverse(), { budget: 60, calorie_limit: 1200, people: 2, excluded: ['辣'] }, { maxNodes: 200000 });
assert.deepEqual(shuffled.items, main.items);
assert.equal(main.objective, 'balanced');
// v1.1: objective selects the main plan; each appears exactly once across plan + alternatives.
function probe(obj) { return solve(menu.items, { storeCode: menu.store.code, budget: 60, calorie_limit: 1200, people: 2, excluded: ['辣'], objective: obj }, { maxNodes: 200000 }); }
const cheapest = probe('cheapest'), lowCal = probe('lowest_calorie');
verify(cheapest); verify(lowCal);
assert.equal(cheapest.objective, 'cheapest');
assert.equal(lowCal.objective, 'lowest_calorie');
assert.equal(main.plan.total_price, 57.9);
assert.ok(cheapest.plan.total_price <= main.plan.total_price);
assert.ok(lowCal.plan.total_calorie <= main.plan.total_calorie);
for (const r of [main, cheapest, lowCal]) {
  const present = new Set([r.objective, ...r.alternatives.map(a => a.objective)]);
  assert.equal(present.size, 3);
  for (const alt of r.alternatives) {
    assert.ok(alt.label && alt.objective);
    assert.ok(alt.items.every(i => i.code && Number.isSafeInteger(i.quantity) && i.quantity > 0 && i.calorie_source === 'official'));
    assert.equal(toFen(alt.items.reduce((s, i) => s + i.price * i.quantity, 0)), toFen(alt.total_price));
    assert.equal(alt.items.reduce((s, i) => s + i.calorie * i.quantity, 0), alt.total_calorie);
  }
}
assert.equal(solve(menu.items, { budget: 60, people: 2, objective: 'unknown' }).error.code, 'BAD_REQUEST');
console.log(JSON.stringify({ ok: true, main: { items: main.items.map(i => `${i.name}x${i.quantity}`), plan: main.plan }, noBudget: { conflict: noBudget.conflict, hint: noBudget.hint }, noCal: { conflict: noCal.conflict, hint: noCal.hint } }, null, 2));

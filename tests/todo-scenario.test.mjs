import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseTodoLedger, buildTodoView, applyTodoEvent, navigationPlan,
  todoBadge, TodoStore,
} from '../mods/agents-order/todo.js';

const SESSION = '11111111-1111-4111-8111-111111111111';
const APPROVAL = {
  id: 'A1', type: '授权', status: '待用户', title: '批准 A1',
  sourceSpace: 'sp1', sourceTab: 'tb1', sourceTerminal: 't31',
  sourceSession: `session:${SESSION}`, sourceAgent: 'DS待办执行(t31)', version: '1',
};
const EXEC = {
  id: 'E1', type: '执行', status: '未处理', title: '执行合并',
  sourceSpace: 'sp1', sourceTab: 'tb1', sourceTerminal: 't31',
  sourceSession: `session:${SESSION}`, sourceAgent: 'DS待办执行(t31)', version: '1',
};

function ledger(approvals = [], agents = []) {
  const head = '| 要你做什么 | 类型 | 状态 | 提出时间 | 项目 | 发起人 | 事项ID | 来源Space | 来源Tab | 来源终端 | 来源会话 | 来源Agent | 版本 |\n|---|---|---|---|---|---|---|---|---|---|---|---|---|';
  const rows = approvals.map(r => `| ${r.title} | ${r.type} | ${r.status} | 2026-11-17T20:00+08:00 | P | t2n | ${r.id} | ${r.sourceSpace} | ${r.sourceTab} | ${r.sourceTerminal} | ${r.sourceSession} | ${r.sourceAgent} | ${r.version} |`);
  const a = '## Agent 待办（待审 / 阻塞）\n| 事项ID | 类型 | 状态 | 标题 | 提出时间 | 项目 | 发起人 | 来源Space | 来源Tab | 来源终端 | 来源会话 | 来源Agent | 版本 |\n|---|---|---|---|---|---|---|---|---|---|---|---|---|';
  const g = agents.map(r => `| ${r.id} | ${r.type} | ${r.status} | ${r.title} | 2026-11-17T20:00+08:00 | P | t31 | ${r.sourceSpace} | ${r.sourceTab} | ${r.sourceTerminal} | ${r.sourceSession} | ${r.sourceAgent} | ${r.version} |`);
  return [head, ...rows, '', a, ...g].join('\n') + '\n';
}

const viewOf = rows => buildTodoView(parseTodoLedger(rows));
const ctx = {
  terminals: [{ address: 't31', state: 'live' }],
  panes: [{ pane: 'p1', terminal: 't31', tab: 'tb1' }],
  spaces: [{ id: 'sp1', tabs: [{ id: 'tb1' }] }],
  focused: { pane: 'p1' },
};
const identity = { ok: true, sessionId: SESSION };

test('explicit processing removes only the targeted item', () => {
  const rows = parseTodoLedger(ledger([APPROVAL, { ...APPROVAL, id: 'A2' }])).rows;
  const result = applyTodoEvent(rows, { eventId: 'd1', type: 'DECISION', itemId: 'A1', expectedVersion: 1 }, new Set());
  assert.equal(result.ok, true);
  const view = buildTodoView({ rows: result.rows, errors: [] });
  assert.deepEqual(view.items.map(i => i.id), ['A2']);
});

test('close/reopen keeps unprocessed rows and drops the explicitly closed one', async () => {
  const read = async () => ledger([APPROVAL]);
  const first = new TodoStore({ read });
  await first.refresh();
  assert.equal(first.state.items.length, 1);
  first.close();

  const reopened = new TodoStore({ read });
  await reopened.refresh();
  assert.equal(reopened.state.items.length, 1);

  const closedRows = applyTodoEvent(parseTodoLedger(await read()).rows,
    { eventId: 'd2', type: 'DECISION', itemId: 'A1', expectedVersion: 1 }, new Set()).rows;
  const afterClose = new TodoStore({ read: async () => buildLedger(closedRows) });
  await afterClose.refresh();
  assert.equal(afterClose.state.items.length, 0);
});

function buildLedger(rows) {
  // The scenario only needs the parser to see the same normalized rows.
  const approvalRows = rows.filter(r => r.table === 'approval');
  return ledger(approvalRows.map(r => ({
    ...r, title: r.title, status: r.done ? '已处理' : r.statusRaw, version: String(r.version),
  })));
}

test('wrong id and stale version never clear or change another item', () => {
  const rows = parseTodoLedger(ledger([APPROVAL])).rows;
  for (const event of [
    { eventId: 'x1', type: 'DECISION', itemId: 'A9', expectedVersion: 1 },
    { eventId: 'x2', type: 'DECISION', itemId: 'A1', expectedVersion: 0 },
    { eventId: 'x3', type: 'DECISION', itemId: 'A1', expectedVersion: 2 },
  ]) {
    const r = applyTodoEvent(rows, event, new Set());
    assert.equal(r.ok, false);
    assert.equal(buildTodoView({ rows: r.rows, errors: [] }).items.length, 1);
  }
});

test('source close/session change keeps the item and refuses navigation', () => {
  const item = viewOf(ledger([APPROVAL])).items[0];
  const closed = navigationPlan(item, { ...ctx, terminals: [] }, identity);
  assert.equal(closed.ok, false);
  assert.equal(closed.reason, 'source_closed');
  const changed = navigationPlan(item, ctx, { ok: true, sessionId: '22222222-2222-4222-8222-222222222222' });
  assert.equal(changed.ok, false);
  assert.equal(changed.reason, 'session_changed');
  const unverified = navigationPlan(item, ctx, { ok: false, reason: 'timeout' });
  assert.equal(unverified.reason, 'session_unverified');
  assert.equal(viewOf(ledger([APPROVAL])).items.length, 1);
});

test('duplicate conflict is visible and cannot be silently cleared by the closed row', () => {
  const view = viewOf(ledger([{ ...APPROVAL, status: '已处理' }, APPROVAL]));
  assert.equal(view.items.length, 1);
  assert.equal(view.items[0].displayState, 'conflict');
  assert.equal(view.items[0].conflict, true);
});

test('read failure/missing never renders as zero and keeps last good rows', async () => {
  const missing = new TodoStore({ read: async () => null });
  await missing.refresh();
  assert.equal(missing.state.kind, 'missing');
  assert.equal(todoBadge(missing.state).kind, 'error');

  let calls = 0;
  const flaky = new TodoStore({ read: async () => (++calls === 1 ? ledger([APPROVAL]) : null) });
  await flaky.refresh();
  await flaky.refresh();
  assert.equal(flaky.state.kind, 'stale');
  assert.equal(flaky.state.items.length, 1);
  assert.equal(todoBadge(flaky.state).stale, true);
});

test('late async result after close cannot overwrite state', async () => {
  let resolveRead;
  const store = new TodoStore({ read: () => new Promise(r => { resolveRead = r; }) });
  const pending = store.refresh();
  store.close();
  resolveRead(ledger([APPROVAL]));
  await pending;
  assert.equal(store.state.kind, 'loading');
});

test('pane-less background source plans use keep, never name fallback', () => {
  const item = viewOf(ledger([APPROVAL])).items[0];
  const keep = navigationPlan(item, { ...ctx, panes: [], focused: { pane: 'p9' } }, identity);
  assert.equal(keep.steps[0].name, 'terminal.keep');
  assert.notEqual(keep.steps[0].name, 'terminal.show');
  assert.notEqual(keep.steps[0].name, 'agent.focus');
});

test('authorization decision and operation success are separate completion points', () => {
  const rows = parseTodoLedger(ledger([APPROVAL], [EXEC])).rows;
  const decided = applyTodoEvent(rows, { eventId: 'a1', type: 'DECISION', itemId: 'A1', expectedVersion: 1 }, new Set());
  assert.equal(decided.ok, true);
  let view = buildTodoView({ rows: decided.rows, errors: [] });
  assert.deepEqual(view.items.map(i => i.id), ['E1']); // 授权决定已结束，执行仍未完成

  const done = applyTodoEvent(decided.rows, { eventId: 'o1', type: 'OPERATION-DONE', itemId: 'E1', expectedVersion: 1 }, new Set());
  assert.equal(done.ok, true);
  view = buildTodoView({ rows: done.rows, errors: [] });
  assert.equal(view.items.length, 0);
});

test('duplicate same version but different status is a conflict', () => {
  const view = viewOf(ledger([APPROVAL, { ...APPROVAL, status: '已处理' }]));
  assert.equal(view.items[0].conflict, true);
});

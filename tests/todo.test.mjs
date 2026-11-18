import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseTodoLedger, buildTodoView, applyTodoEvent, navigationPlan,
  agentIconState, todoBadge, modeAfterToggle, TodoStore, subAgentState, modeActions,
} from '../mods/agents-order/todo.js';
import { sessionIdFromOmpPaths, pickDshSession, programKey } from '../mods/agents-order/session.mjs';

const approval = (id, status = '待用户', version = '1', extra = {}) => ({
  id, type: '授权', status, version, title: `批准 ${id}`,
  sourceSpace: 'sp1', sourceTab: 'tb1', sourceTerminal: 't31',
  sourceSession: 'session:11111111-1111-4111-8111-111111111111',
  sourceAgent: 'DS待办执行(t31)', ...extra,
});
const agentRow = (id, type = '待审', status = '未处理', version = '1', extra = {}) => ({
  id, type, status, version, title: `待审 ${id}`,
  sourceSpace: 'sp1', sourceTab: 'tb1', sourceTerminal: 't31',
  sourceSession: 'session:11111111-1111-4111-8111-111111111111',
  sourceAgent: 'DS待办执行(t31)', ...extra,
});

const ledger = (approvals, agents) => {
  const a = ['| 要你做什么 | 类型 | 状态 | 提出时间 | 项目 | 发起人 | Space | 事项ID | 来源Space | 来源Tab | 来源终端 | 来源会话 | 来源Agent | 版本 |',
    '|---|---|---|---|---|---|---|---|---|---|---|---|---|---|',
    ...approvals.map(r => `| ${r.title} | ${r.type} | ${r.status} | 2026-11-17T20:00+08:00 | P | t2n | S | ${r.id} | ${r.sourceSpace} | ${r.sourceTab} | ${r.sourceTerminal} | ${r.sourceSession} | ${r.sourceAgent} | ${r.version} |`)];
  const g = ['## Agent 待办（待审 / 阻塞）', '',
    '| 事项ID | 类型 | 状态 | 标题 | 提出时间 | 项目 | 发起人 | 来源Space | 来源Tab | 来源终端 | 来源会话 | 来源Agent | 版本 | 证据 |',
    '|---|---|---|---|---|---|---|---|---|---|---|---|---|---|',
    ...(agents ?? []).map(r => `| ${r.id} | ${r.type} | ${r.status} | ${r.title} | 2026-11-17T20:00+08:00 | P | t31 | ${r.sourceSpace} | ${r.sourceTab} | ${r.sourceTerminal} | ${r.sourceSession} | ${r.sourceAgent} | ${r.version} | card |`)];
  return a.join('\n') + '\n\n' + g.join('\n') + '\n';
};

test('parses both tables and keeps approval/agent origin', () => {
  const parsed = parseTodoLedger(ledger([approval('A1')], [agentRow('R1')]));
  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.rows.map(r => [r.table, r.id]), [['approval', 'A1'], ['agent', 'R1']]);
});

test('completed historical rows missing new fields are skipped, pending legacy rows stay visible', () => {
  const text = `| 要你做什么 | 类型 | 状态 |
|---|---|---|
| old done | 授权 | 已处理 |
| old pending | 授权 | 待用户 |
`;
  const parsed = parseTodoLedger(text);
  const view = buildTodoView(parsed);
  assert.equal(view.items.length, 1);
  assert.equal(view.items[0].legacy, true);
  assert.equal(view.items[0].displayState, 'needs_user');
  assert.equal(view.errors.length, 0);
});

test('same id/version identical rows collapse; different status or version becomes conflict', () => {
  const same = buildTodoView(parseTodoLedger(ledger([approval('A1'), approval('A1')], [])));
  assert.equal(same.items.length, 1);
  assert.equal(same.items[0].conflict, false);
  assert.equal(same.items[0].duplicateCount, 2);

  const diffStatus = buildTodoView(parseTodoLedger(ledger([approval('A2'), approval('A2', '已处理')], [])));
  assert.equal(diffStatus.items.length, 1);
  assert.equal(diffStatus.items[0].conflict, true);
  assert.equal(diffStatus.items[0].displayState, 'conflict');

  const diffVersion = buildTodoView(parseTodoLedger(ledger([approval('A3', '待用户', '1'), approval('A3', '待用户', '2')], [])));
  assert.equal(diffVersion.items[0].conflict, true);
});

test('closed duplicate never hides an open one; all closed clears', () => {
  const mixed = buildTodoView(parseTodoLedger(ledger([approval('A4', '已处理'), approval('A4', '待用户')], [])));
  assert.equal(mixed.items.length, 1);
  assert.equal(mixed.items[0].conflict, true);
  assert.equal(mixed.items[0].displayState, 'conflict');

  const allClosed = buildTodoView(parseTodoLedger(ledger([approval('A5', '已处理'), approval('A5', '已处理')], [])));
  assert.equal(allClosed.items.length, 0);
});

test('invalid id is visible as an error row, not silently zero', () => {
  const text = `## Agent 待办
| 事项ID | 类型 | 状态 | 标题 | 版本 |
|---|---|---|---|---|
| bad id! | 待审 | 未处理 | bad | 1 |
`;
  const view = buildTodoView(parseTodoLedger(text));
  assert.ok(view.errors.length >= 1);
});

test('TODO-EVENT enforces expectedVersion, idempotency and operation/decision split', () => {
  let rows = [];
  let seen = new Set();
  const open = { eventId: 'e1', type: 'OPEN', itemId: 'A1', expectedVersion: 0, kind: '待审', title: 't', source: { terminal: 't31' } };
  let r = applyTodoEvent(rows, open, seen);
  assert.equal(r.ok, true); rows = r.rows; seen = r.seenEvents;
  assert.equal(rows[0].version, 1);

  const again = applyTodoEvent(rows, open, seen);
  assert.equal(again.ok, true); assert.equal(again.idempotent, true);

  const stale = applyTodoEvent(rows, { ...open, eventId: 'e2', type: 'DECISION', expectedVersion: 0 }, seen);
  assert.equal(stale.ok, false); assert.equal(stale.reason, 'stale-version');

  const wrongKind = applyTodoEvent(rows, { ...open, eventId: 'e3', type: 'OPERATION-DONE', expectedVersion: 1 }, seen);
  assert.equal(wrongKind.ok, false);

  const decision = applyTodoEvent(rows, { ...open, eventId: 'e4', type: 'REWORK', expectedVersion: 1 }, seen);
  assert.equal(decision.ok, true);
  assert.equal(decision.rows[0].version, 2);
});

test('navigation requires exact source + verified session and uses keep for pane-less', () => {
  const item = buildTodoView(parseTodoLedger(ledger([approval('A1')], []))).items[0];
  const space = { id: 'sp1', tabs: [{ id: 'tb1' }] };
  const pane = { pane: 'p1', terminal: 't31', tab: 'tb1' };
  const identity = { ok: true, sessionId: '11111111-1111-4111-8111-111111111111' };
  const ctx = { terminals: [{ address: 't31', state: 'live' }], panes: [pane], spaces: [space], focused: { pane: 'p1' } };
  const ok = navigationPlan(item, ctx, identity);
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.steps.map(s => s.name), ['space.select', 'tab.select', 'pane.focus']);

  const noSession = navigationPlan(item, ctx, { ok: false, reason: 'unverified' });
  assert.equal(noSession.ok, false); assert.equal(noSession.reason, 'session_unverified');

  const noPane = navigationPlan(item, { ...ctx, panes: [], focused: { pane: null } }, identity);
  assert.equal(noPane.ok, true); assert.equal(noPane.steps[0].name, 'terminal.keep');

  const keepWithFocused = navigationPlan(item, { ...ctx, panes: [], focused: { pane: 'p9' } }, identity);
  assert.equal(keepWithFocused.steps[0].name, 'terminal.keep');
});

test('agent icon is action-first but leaves native status mapping alone', () => {
  const items = buildTodoView(parseTodoLedger(ledger([], [agentRow('R1')]))).items;
  assert.equal(agentIconState({ address: 't31', status: 'working' }, items, {}), 'review');
  assert.equal(agentIconState({ address: 't31', status: 'working' }, [], {}), 'working');
  assert.equal(agentIconState({ address: 't31', status: 'done' }, [], {}), 'idle');
  assert.equal(agentIconState({ address: 't31', status: 'blocked' }, [], {}), 'blocked');
});

test('badge never shows 0 for missing/error and distinguishes stale', () => {
  assert.deepEqual(todoBadge({ kind: 'missing', items: [] }), { kind: 'error', text: '!' });
  assert.deepEqual(todoBadge({ kind: 'error', items: [] }), { kind: 'error', text: '!' });
  assert.deepEqual(todoBadge({ kind: 'ready', items: [] }), { kind: 'hidden', text: '' });
  assert.deepEqual(todoBadge({ kind: 'stale', items: [{ id: 'a' }] }), { kind: 'count', text: '1', stale: true });
});

test('mode switch is ignored while dragging', () => {
  assert.equal(modeAfterToggle('agents', true), 'agents');
  assert.equal(modeAfterToggle('agents', false), 'todo');
  assert.equal(modeAfterToggle('todo', false), 'agents');
});

test('TodoStore is single-flight, stale-safe and closed-safe', async () => {
  let resolveRead;
  const read = () => new Promise(r => { resolveRead = r; });
  const store = new TodoStore({ read });
  const p1 = store.refresh();
  const p2 = store.refresh();
  assert.equal(p1, p2);
  store.close();
  resolveRead(ledger([approval('A1')], []));
  await p1;
  assert.equal(store.state.kind, 'loading');

  const good = new TodoStore({ read: async () => ledger([approval('A1')], []) });
  await good.refresh();
  assert.equal(good.state.kind, 'ready');
  assert.equal(good.state.items.length, 1);

  const missing = new TodoStore({ read: async () => null });
  await missing.refresh();
  assert.equal(missing.state.kind, 'missing');
  assert.equal(todoBadge(missing.state).kind, 'error');

  const afterGood = new TodoStore({ read: async () => null });
  await afterGood.refresh();
  assert.equal(afterGood.state.kind, 'missing');
});

test('session helpers recognize omp lock and dsh owners without reading content', () => {
  assert.equal(sessionIdFromOmpPaths([
    '/Users/x/.omp/agent/sessions/-p/2026-11-17T00-00-00_uuid.jsonl',
    '/Users/x/.omp/run/session-owners/22222222-2222-4222-8222-222222222222.lock',
  ]), '22222222-2222-4222-8222-222222222222');
  assert.equal(pickDshSession({ owners: [{ pid: 2, sessionIds: ['s1'] }, { pid: 3, sessionIds: ['s2'] }] }, new Set([1, 2])).sessionId, 's1');
  assert.equal(programKey(['node', '/x/dsh-tui', '--']), 'dsh-tui');
  assert.equal(programKey(['omp', '--approval-mode=always-ask']), 'omp');
});

test('repeated open after keep accepts the new pane tab when terminal/session stay identical', () => {
  const item = buildTodoView(parseTodoLedger(ledger([approval('A1')], []))).items[0];
  const before = {
    terminals: [{ address: 't31', state: 'live' }],
    panes: [],
    spaces: [{ id: 'sp1', tabs: [{ id: 'tb1' }] }],
    focused: {},
  };
  const first = navigationPlan(item, before, { ok: true, sessionId: '11111111-1111-4111-8111-111111111111' });
  assert.equal(first.ok, true); assert.equal(first.steps[0].name, 'terminal.keep');

  const after = {
    terminals: [{ address: 't31', state: 'live' }],
    panes: [{ pane: 'p-new', terminal: 't31', tab: 'tb-child' }],
    spaces: [{ id: 'sp1', tabs: [{ id: 'tb1' }, { id: 'tb-child' }] }],
    focused: { pane: 'p-new' },
  };
  const second = navigationPlan(item, after, { ok: true, sessionId: '11111111-1111-4111-8111-111111111111' });
  assert.equal(second.ok, true);
  assert.equal(second.kind, 'pane');
  assert.deepEqual(second.steps.map(s => s.name), ['space.select', 'tab.select', 'pane.focus']);
  assert.equal(second.steps[1].args.id, 'tb-child');
});

test('review passed and blocked cleared are explicit success events with kind guards', () => {
  const rows = parseTodoLedger(ledger([], [agentRow('R1', '待审'), agentRow('B1', '阻塞')])).rows;
  const wrong = applyTodoEvent(rows, { eventId: 'w1', type: 'REVIEW-PASSED', itemId: 'B1', expectedVersion: 1 }, new Set());
  assert.equal(wrong.ok, false); assert.equal(wrong.reason, 'wrong-kind');

  const stale = applyTodoEvent(rows, { eventId: 's1', type: 'REVIEW-PASSED', itemId: 'R1', expectedVersion: 2 }, new Set());
  assert.equal(stale.ok, false); assert.equal(stale.reason, 'stale-version');

  const seen = new Set();
  const passed = applyTodoEvent(rows, { eventId: 'p1', type: 'REVIEW-PASSED', itemId: 'R1', expectedVersion: 1 }, seen);
  assert.equal(passed.ok, true);
  const repeat = applyTodoEvent(passed.rows, { eventId: 'p1', type: 'REVIEW-PASSED', itemId: 'R1', expectedVersion: 1 }, passed.seenEvents);
  assert.equal(repeat.ok, true); assert.equal(repeat.idempotent, true);
  assert.equal(repeat.rows.find(r => r.id === 'R1').version, 2);
  let view = buildTodoView({ rows: passed.rows, errors: [] });
  assert.deepEqual(view.items.map(i => i.id), ['B1']);

  const unblocked = applyTodoEvent(passed.rows, { eventId: 'u1', type: 'UNBLOCKED', itemId: 'B1', expectedVersion: 1 }, new Set());
  assert.equal(unblocked.ok, true);
  view = buildTodoView({ rows: unblocked.rows, errors: [] });
  assert.equal(view.items.length, 0);
});

test('read exception is error/stale, not missing; missing is only null', async () => {
  const failed = new TodoStore({ read: async () => { throw new Error('io'); } });
  await failed.refresh();
  assert.equal(failed.state.kind, 'error');
  assert.deepEqual(failed.state.errors, ['read']);

  let calls = 0;
  const afterGood = new TodoStore({ read: async () => {
    calls += 1;
    if (calls === 1) return ledger([approval('A1')], []);
    throw new Error('io');
  } });
  await afterGood.refresh();
  await afterGood.refresh();
  assert.equal(afterGood.state.kind, 'stale');
  assert.equal(afterGood.state.items.length, 1);
  assert.deepEqual(afterGood.state.errors, ['read']);
});

test('delayed mode handler uses the click cx, never a captured render cx', async () => {
  const view = { mode: 'agents', drag: false };
  let refreshHits = 0;
  const actions = modeActions(view, () => {}, (cx) => { refreshHits += 1; return cx; });
  let renderHits = 0, clickHits = 0;
  const renderCx = { notify: () => { renderHits += 1; } };
  const clickCx = { notify: () => { clickHits += 1; } };
  void renderCx;
  await Promise.resolve();
  assert.equal(actions.todo(clickCx), true);
  assert.equal(actions.refresh(clickCx), clickCx);
  assert.equal(view.mode, 'todo');
  assert.equal(clickHits, 1);
  assert.equal(refreshHits, 1);
  assert.equal(renderHits, 0);
});

test('parent and child keep separate action states by address', () => {
  const items = buildTodoView(parseTodoLedger(ledger([], [
    agentRow('R1', '待审', '未处理', '1', { sourceTerminal: 't2n' }),
    agentRow('B1', '阻塞', '未处理', '1', { sourceTerminal: 't31' }),
  ]))).items;
  assert.equal(agentIconState({ address: 't2n', status: 'working' }, items, {}), 'review');
  assert.equal(subAgentState({ address: 't31' }, 'working', items, {}), 'blocked');
});

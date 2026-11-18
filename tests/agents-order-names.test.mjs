import test from 'node:test';
import assert from 'node:assert/strict';
import { displayName, validateName, validateEdit, tabSyncPlan, commitName, waitForTabName, focusIfOpen, autoNameFromTitle, shouldAutoName, autoNameCandidate } from '../mods/agents-order/names.js';

test('stored workbench.name wins and is never truncated or replaced by dynamic title', () => {
  const long = '这是一个已经存在的长任务名称不应截断';
  assert.equal(displayName({ 'workbench.name': long }, '动态 title'), long);
  assert.equal(displayName({ 'workbench.name': '  ' }, '动态 title'), '动态 title');
  assert.equal(displayName({}, '动态 title'), '动态 title');
});

test('parent and child resolve independent names from their own labels', () => {
  const parent = { 'workbench.name': '界面统筹与验收' };
  const child = { 'workbench.name': '待办交互实现' };
  assert.equal(displayName(parent, 'parent-title'), '界面统筹与验收');
  assert.equal(displayName(child, 'child-title'), '待办交互实现');
  assert.notEqual(displayName(parent, 'x'), displayName(child, 'x'));
});

test('new-name validation rejects empty/overlong/duplicate but read path keeps long names', () => {
  assert.equal(validateName('', []), '请输入简短任务名');
  assert.equal(validateName('一二三四五六七八九十一二三四五六七', []), '任务名请控制在 16 字以内');
  assert.equal(validateName('同名', ['同名']), '当前 Space 已有同名任务');
  assert.equal(validateName('短名', []), null);
  const long = '这是一个已经存在的长任务名称不应截断';
  assert.equal(validateEdit(long, long, []), null);
  assert.equal(validateEdit('短名', '这是一个新的超长任务名称一二三四五六七', []), '任务名请控制在 16 字以内');
});

test('tab sync only for a single-agent tab and never for empty names', () => {
  const agent = { address: 't1', tab: 'tab1', tab_name: 'old' };
  assert.deepEqual(tabSyncPlan([{ tab: 'tab1', terminal: 't1' }], agent, 'new'), { id: 'tab1', name: 'new' });
  assert.equal(tabSyncPlan([{ tab: 'tab1', terminal: 't1' }, { tab: 'tab1', terminal: 't2' }], agent, 'new'), null);
  assert.equal(tabSyncPlan([{ tab: 'tab1', terminal: 't1' }], agent, ''), null);
  assert.equal(tabSyncPlan([{ tab: 'tab1', terminal: 't2' }], agent, 'new'), null);
});

test('label failure keeps old name and reports failure; empty write is explicit clear', async () => {
  const writes = [];
  const failed = await commitName({
    address: 't1', name: 'new', currentName: 'old',
    label: async (_addr, values) => { writes.push(values); throw new Error('offline'); },
  });
  assert.equal(failed.ok, false);
  assert.equal(failed.name, 'old');
  assert.match(failed.error, /未保存/);

  const cleared = await commitName({
    address: 't1', name: '', currentName: 'old',
    label: async (_addr, values) => writes.push(values),
  });
  assert.equal(cleared.ok, true);
  assert.equal(cleared.name, '');
  assert.deepEqual(writes.at(-1), { 'workbench.name': '' });
});

test('label success with tab sync failure reports partial success, not label failure', async () => {
  const result = await commitName({
    address: 't1', name: 'new', currentName: 'old',
    label: async () => {},
    syncTab: async () => { throw new Error('tab failed'); },
  });
  assert.equal(result.ok, true);
  assert.equal(result.name, 'new');
  assert.equal(result.tabSyncFailed, true);
  assert.match(result.error, /标签页/);
});

test('tab name wait accepts delayed host echo and fails only after bounded attempts', async () => {
  let reads = 0, waits = 0;
  const delayed = await waitForTabName({
    plan: { id: 'tab1' }, name: 'new',
    read: () => ({ id: 'tab1', name: ++reads < 3 ? 'old' : 'new' }),
    wait: async () => { waits += 1; },
    attempts: 5,
  });
  assert.equal(delayed.ok, true);
  assert.equal(waits, 2);

  const never = await waitForTabName({
    plan: { id: 'tab1' }, name: 'new',
    read: () => ({ id: 'tab1', name: 'old' }),
    wait: async () => {},
    attempts: 3,
  });
  assert.equal(never.ok, false);
  assert.equal(never.reason, 'tab-name-timeout');
});

test('focus timer callback is a no-op after close', () => {
  let focused = 0;
  assert.equal(focusIfOpen(true, () => { focused += 1; }), false);
  assert.equal(focusIfOpen(false, () => { focused += 1; }), true);
  assert.equal(focused, 1);
});

test('title cleaner extracts OMP/DS semantic names but rejects cwd/product/id-only', () => {
  assert.equal(autoNameFromTitle('π ⠙ 🖥️ AGENT: 修复自动命名', 'OMP', '/Users/x/AIAgentCLI'), '修复自动命名');
  assert.equal(autoNameFromTitle('⠐ 🐋 DS Harness 方案调查', 'DeepSeek Harness', '/Users/x/app'), '方案调查');
  assert.equal(autoNameFromTitle('AIAgentCLI', 'Codex', '/Users/x/AIAgentCLI'), null);
  assert.equal(autoNameFromTitle('Codex', 'Codex', '/Users/x/app'), null);
  assert.equal(autoNameFromTitle('HD-WORKFLOW-01', 'OMP', '/Users/x/app'), null);
  assert.equal(autoNameFromTitle('', 'OMP', '/'), null);
});

test('real long English title gets word-bounded truncation, Chinese sentence takes first segment', () => {
  const long = autoNameFromTitle('π > 🧭 SPEC: Explain OpenSpec+CodeGraph+memory workflow', 'OMP', '/Users/x/app');
  assert.ok(long, 'long English title must not be rejected');
  assert.match(long, /^Explain OpenSpec/);
  assert.ok([...long].length <= 24);
  assert.match(long, /…$/);

  assert.equal(autoNameFromTitle('π > 🤖 OMP: 安装配置 Magpie 并介绍模型统一管理', 'OMP', '/Users/x/app'), '安装配置 Magpie');
  assert.equal(autoNameFromTitle('✦ 🐋 查看 T3 代码情况', 'DeepSeek Harness', '/Users/x/app'), '查看 T3 代码情况');
  assert.equal(autoNameFromTitle('AIAgentCLI', 'Codex', '/Users/x/AIAgentCLI'), null);
  assert.equal(autoNameFromTitle('', 'OMP', '/'), null);
});

test('markup-wrapped title keeps only inner task text', () => {
  assert.equal(
    autoNameFromTitle('π > 🤖 OMP: <标题>调研近期热门多agent项目工具</标题>', 'OMP', '/Users/x/app'),
    '调研近期热门多agent项目工具',
  );
  assert.equal(autoNameFromTitle('<标题></标题>', 'OMP', '/Users/x/app'), null);
});


test('manual names are protected; only missing/auto names can be auto-named', () => {
  assert.equal(shouldAutoName({}), true);
  assert.equal(shouldAutoName({ 'workbench.name': '人工名' }), false);
  assert.equal(shouldAutoName({ 'workbench.name': '人工名', 'workbench.name.source': 'manual' }), false);
  assert.equal(shouldAutoName({ 'workbench.name': '自动名', 'workbench.name.source': 'auto' }), true);

  assert.equal(autoNameCandidate({ labels: { 'workbench.name': '人工名' }, title: 'AGENT: 新任务', program: 'OMP' }), null);
  assert.deepEqual(autoNameCandidate({ labels: {}, title: 'AGENT: 新任务', program: 'OMP' }), { name: '新任务', source: 'auto' });
  assert.deepEqual(autoNameCandidate({ labels: { 'workbench.name': '旧自动', 'workbench.name.source': 'auto' }, title: 'DS Harness 新任务', program: 'DeepSeek Harness' }), { name: '新任务', source: 'auto' });
  assert.equal(autoNameCandidate({ labels: { 'workbench.name': '同自动', 'workbench.name.source': 'auto' }, title: 'DS Harness 同自动', program: 'DeepSeek Harness' }), null);
});

test('manual rename writes source=manual so later scans cannot overwrite', async () => {
  const writes = [];
  const result = await commitName({
    address: 't1', name: '人工新名', currentName: '旧名', source: 'manual',
    label: async (_addr, values) => writes.push(values),
  });
  assert.equal(result.ok, true);
  assert.deepEqual(writes[0], { 'workbench.name': '人工新名', 'workbench.name.source': 'manual' });
});

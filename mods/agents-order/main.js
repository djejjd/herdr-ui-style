// Agents in grouped or priority views; parents take their most urgent sub-agent's place.

import { View, div, image, svg } from "gpui-kit";
import { v_flex, h_flex, ScrollHandle, InputState, Input } from "gpui-base";
import { agents, terminals, panes, focused, spaces, run, hc, theme, shared, setShared, setAgentOrder, openOverlay, closeOverlay, props, window as herdrWindow, layout, checking, home, appHome, readTextFile, exec, notify } from "herdr";
import { orderedGroup, orderedBySpace, reorderGroup, dragDecision, releaseTime, dropIndex, rowCenters, projectedPositions, persistOrder } from "./order.js";
import { TodoStore, navigationPlan, agentIconState, todoBadge, modeAfterToggle, preserveSelection, applyModeAction, modeActions, subAgentState } from "./todo.js";
import { modeHeader, todoBody, todoRefreshIcon, statusIcon } from "./todo-view.js";
import { displayName, validateName, validateEdit, tabSyncPlan, commitName, waitForTabName, focusIfOpen, autoNameCandidate, shouldAutoName } from "./names.js";

function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = find(child, id);
    if (found) return found;
  }
  return null;
}

// The sidebar's rail goes by its width, not a flag: dragging its edge narrows it too.
const narrow = () => (find(layout(), "sidebar")?.size?.px ?? Infinity) < 160;

// To the rail (on macOS wide enough for the traffic lights), or back to the width it had.
function toggleSidebar() {
  const width = find(layout(), "sidebar")?.size?.px;
  if (!narrow()) setShared("sidebar.width", width);
  // Mods edited before the rail went by width still read the flag.
  setShared("sidebar.collapsed", !narrow());
  run("layout.resize", { id: "sidebar", px: narrow() ? (shared("sidebar.width") ?? 268) : herdrWindow()?.platform === "macos" ? 76 : 44 });
}

const clean = (s) => (s ?? "").replace(/^[^\p{L}\p{N}]+/u, "").trim();

function leadPanes(all) {
  const leads = new Map();
  for (const p of all) {
    if (!p.terminal) continue;
    const current = leads.get(p.tab);
    // First agent, else first focused terminal, else first terminal in the tab.
    if (!current || (!current.program?.agent && (p.program?.agent || (!current.focused && p.focused)))) leads.set(p.tab, p);
  }
  return leads;
}

function title(tab, l) {
  const prog = l?.program?.name;
  const live = clean(l?.title);
  // clean() would strip a path's leading ~ or /: test the title with only its status glyph gone.
  const path = /^[~/]|^[A-Za-z]:\\/.test((l?.title ?? "").replace(/^[^\p{L}\p{N}~/]+/u, ""));
  const telling = live && live !== prog && !path && !live.includes("@") && live.toLowerCase() !== l?.program?.key;
  return (tab.name === prog || !tab.named) && telling ? live : tab.name;
}
const RANK = { blocked: 4, done: 3, working: 2, idle: 1 };
const MODE_KEY = "agents-order.mode";
const TODO_SELECT_KEY = "agents-order.todo.selected";
// A sub-agent without a pane isn't in agents(): its raw word, error counting as
// blocked. It's never done: it reports to its parent, and the parent's done is the news.
const kidStatus = (k, listed) => {
  const s = listed.get(k.address) ?? k.status;
  return s === "error" ? "blocked" : s === "done" ? "idle" : s;
};
const SORTS = [
  { id: "priority", label: "Priority", icon: "clock" },
  { id: "grouped", label: "Grouped by space", icon: "layers" },
];
const sortOf = () => SORTS.find((s) => s.id === shared("agents.sort")) ?? SORTS[0];
const SECTION = { 4: "Needs you", 3: "Done", 2: "Working", 1: "Idle" };
const SECTION_STATUS = { 4: "blocked", 3: "done", 2: "working" };

function duration(ms) {
  const m = Math.floor(ms / 60000);
  if (m < 1) return "<1m";
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h}h` : `${Math.floor(h / 24)}d`;
}

// The agent's icon from the app's program table: a one-color glyph or a picture.
function icon(p, size, color) {
  if (!p?.icon) return null;
  return p.tint ? svg(p.icon).size(size).flex_none().text_color(color) : image(p.icon).w(size).h(size).flex_none();
}

export default class Agents extends View {
  init(_props, cx) {
    if (props()?.sortMenu) return;
    this.closed = false;
    if (props()?.rename) {
      this.handle = cx.focus_handle();
      this.handle.focus();
      this.renameBusy = false;
      this.renameError = "";
      this.renameClearConfirm = false;
      this.initRename(cx);
      return;
    }
    this.folded = new Set();
    // Each agent's last state and when it changed (ms), kept across restarts.
    this.changed = JSON.parse(localStorage.getItem("changed") ?? "{}");
    this.pendingPins = JSON.parse(localStorage.getItem("pins") ?? "[]");
    if (!this.pendingPins.length) localStorage.removeItem("pins");
    this.migratingPins = new Set();
    this.drag = null;
    this.dragTimer = null;
    this.busy = new Set();
    this.previews = new Map();
    this.error = "";
    this.focusHandle = cx.focus_handle();
    this.mode = props()?.todoMode === "todo" || localStorage.getItem(MODE_KEY) === "todo" ? "todo" : "agents";
    this.todo = new TodoStore({ read: async () => readTextFile(this.todoPath()) });
    this.todoState = this.todo.state;
    this.todoSelected = localStorage.getItem(TODO_SELECT_KEY);
    this.todoFailure = null;
    this.todoReading = false;
    this.todoClickSeq = 0;
    this.todoNavTimer = null;
    this.todoVerified = {};
    this.todoScroll = ScrollHandle.new();
    this.autoNamePending = new Set();
    this.autoNameTries = new Map();
    this.autoNameBlocked = new Set();
    cx.timer.every(30000, (cx) => cx.notify());
    if (!checking()) {
      this.todoTimer = cx.timer.every(2000, (cx) => this.refreshTodo(cx));
      this.refreshTodo(cx);
    }
  }

  todoPath() {
    const fixture = props()?.todoFixture;
    if (typeof fixture === "string" && (fixture.startsWith("/tmp/") || fixture.startsWith("/private/tmp/"))) return fixture;
    return `${home()}/ai/collab/pending.md`;
  }

  modeHeaderView(t, sort) {
    const badge = todoBadge(this.todoState);
    const sortButton = div().id("ag-sort").text_size(11).text_color(t.dim)
      .hover((s) => s.text_color(t.foreground))
      .on_click(() => openOverlay({ mod: "agents-order", kind: "popup", width: 200, height: 140, props: { sortMenu: true } }))
      .tooltip(`Sort agents: ${sort.label}`)
      .child(svg(`mods/workspace-chrome/${sort.icon}.svg`).size(14));
    const actions = modeActions(this, (mode) => localStorage.setItem(MODE_KEY, mode), (cx) => this.refreshTodo(cx));
    return modeHeader(t, this.mode, badge, {
      agents: actions.agents,
      todo: actions.todo,
      right: this.mode === "agents" ? sortButton : todoRefreshIcon(t, actions.refresh),
    });
  }

  switchMode(mode, cx) {
    return applyModeAction(this, mode, cx, (next) => localStorage.setItem(MODE_KEY, next));
  }

  refreshTodo(cx) {
    if (this.closed || this.todoReading) return;
    this.todoReading = true;
    const pending = this.todo.refresh();
    cx.spawn(async (cx) => {
      try { await pending; } catch { /* TodoStore 已把读取失败落成 error/stale。 */ }
      this.todoReading = false;
      if (this.closed) return;
      this.todoState = this.todo.state;
      this.todoSelected = preserveSelection(this.todoSelected, this.todoState.items);
      if (this.todoSelected) localStorage.setItem(TODO_SELECT_KEY, this.todoSelected);
      else localStorage.removeItem(TODO_SELECT_KEY);
      cx.notify();
    });
  }

  verifyTodoSource(item) {
    if (!item?.source?.sessionId) return Promise.resolve({ ok: false, reason: "unverified" });
    return exec("node", [appHome() + "/mods/agents-order/session.mjs", "verify", item.source.terminal, item.source.sessionId], { timeout: 5000 })
      .then((r) => {
        try { return JSON.parse(r.stdout); } catch { return { ok: false, reason: "verify-output" }; }
      })
      .catch(() => ({ ok: false, reason: "verify-timeout" }));
  }

  navReason(reason) {
    return {
      source_closed: "来源终端已关闭，事项保留",
      source_changed: "来源身份已变化，事项保留",
      session_changed: "来源会话已变化，事项保留",
      session_unverified: "无法核验来源会话，事项保留",
      source_missing: "来源未记录，无法精确打开",
      unresolvable: "冲突/只读事项，无法打开",
    }[reason] ?? `无法打开：${reason ?? "未知原因"}`;
  }

  openTodo(item, cx) {
    if (this.drag) return;
    this.todoSelected = item.id;
    this.todoFailure = null;
    if (item.conflict || item.legacy || item.versionError) {
      this.todoFailure = { id: item.id, reason: item.conflict ? "冲突记录，需监督方修正" : "缺少稳定 ID/版本，无法跳转" };
      cx.notify();
      return;
    }
    if (!item.source?.sessionId) {
      this.todoFailure = { id: item.id, reason: this.navReason("session_unverified") };
      cx.notify();
      return;
    }
    const seq = ++this.todoClickSeq;
    const rev = item.rev;
    cx.notify();
    cx.spawn(async (cx) => {
      const identity = await this.verifyTodoSource(item);
      if (this.closed || seq !== this.todoClickSeq) return;
      const current = (this.todoState.items ?? []).find(i => i.id === item.id);
      if (!current || current.rev !== rev) {
        this.todoFailure = { id: item.id, reason: "事项已变化，请重试" };
        cx.notify();
        return;
      }
      if (!identity.ok) {
        this.todoFailure = { id: item.id, reason: this.navReason(identity.reason) };
        cx.notify();
        return;
      }
      const plan = navigationPlan(current, { terminals: terminals(), panes: panes(), spaces: spaces(), focused: focused() }, identity);
      if (!plan.ok) {
        this.todoFailure = { id: item.id, reason: this.navReason(plan.reason) };
        cx.notify();
        return;
      }
      this.todoVerified[current.source.terminal] = identity.sessionId;
      try {
        for (const step of plan.steps) run(step.name, step.args);
        this.todoFailure = null;
      } catch {
        this.todoFailure = { id: item.id, reason: "导航命令失败，事项保留" };
      }
      cx.notify();
      if (plan.kind !== "pane") this.watchTodoNavigation(current, seq, cx);
    });
  }

  watchTodoNavigation(item, seq, cx) {
    this.todoNavTimer?.cancel();
    let ticks = 0;
    this.todoNavTimer = cx.timer.every(200, (cx) => {
      if (this.closed || seq !== this.todoClickSeq) {
        this.todoNavTimer?.cancel();
        this.todoNavTimer = null;
        return;
      }
      ticks += 1;
      const f = focused();
      const terminal = item.source.terminal;
      const ok = f?.shown === terminal || f?.terminal === terminal || panes().some(p => p.terminal === terminal);
      if (ok) {
        this.todoNavTimer?.cancel();
        this.todoNavTimer = null;
        this.todoFailure = null;
        cx.notify();
        return;
      }
      if (ticks >= 10) {
        this.todoNavTimer?.cancel();
        this.todoNavTimer = null;
        this.todoFailure = { id: item.id, reason: "导航未确认：目标未出现" };
        cx.notify();
      }
    });
  }

  todoShell(t) {
    return v_flex().relative().track_focus(this.focusHandle).size_full().min_h(0)
      .bg(t.chrome).border_t(1).border_color(t.border).text_size(13)
      .when(!narrow(), (el) => el.child(this.modeHeaderView(t, sortOf())))
      .when(this.error, (el) => el.child(div().px(12).py(4).text_size(11).text_color(t.blocked).child(this.error)))
      .child(todoBody(t, this.todoState, this.todoSelected, this.todoFailure,
        (item, cx) => this.openTodo(item, cx), this.todoScroll))
      .when(narrow(), (el) => el.child(h_flex().h(28).items_center().justify_center()
        .child(div().id("collapse").text_size(13).text_color(t.dim).hover((s) => s.text_color(t.foreground))
          .on_click(toggleSidebar).child("»"))));
  }

  writeLabel(address, values) {
    return hc(["label", address, ...Object.entries(values).map(([k, v]) => `${k}=${v}`)])
      .then(r => { if (r.code !== 0) throw new Error("label write failed"); return r; });
  }

  // 现有 live Agent 的标题清洗；人工名/未知标题不写，失败最多重试两次。
  scanAutoNames(all, cx) {
    if (checking() || this.closed) return;
    for (const a of agents()) {
      if (this.autoNamePending.has(a.address) || this.autoNameBlocked.has(a.address)) continue;
      const tries = this.autoNameTries.get(a.address) ?? 0;
      if (tries >= 2) continue;
      const term = all.find(t => t.address === a.address);
      if (!term || term.state !== "live") continue;
      const candidate = autoNameCandidate({
        labels: term.labels ?? {}, title: a.title, program: a.program?.name,
        cwd: term.cwd, address: a.address,
      });
      if (!candidate) continue;
      this.autoNamePending.add(a.address);
      cx.spawn(async (cx) => {
        try {
          const current = terminals().find(t => t.address === a.address);
          if (!current || !shouldAutoName(current.labels ?? {}) || this.autoNameBlocked.has(a.address)) return;
          await this.writeLabel(a.address, { "workbench.name": candidate.name, "workbench.name.source": "auto" });
        } catch {
          this.autoNameTries.set(a.address, (this.autoNameTries.get(a.address) ?? 0) + 1);
        } finally {
          this.autoNamePending.delete(a.address);
          if (!this.closed) cx.notify();
        }
      });
    }
  }

  initRename(cx) {
    const name = props().name ?? "";
    this.input = InputState.new({ value: name });
    if (name) this.input.set_selected_range({ start: 0, end: name.length });
    this.inputFocused = true;
    this.input.on("change", (_e, cx) => { this.renameError = ""; this.renameClearConfirm = false; cx.notify(); });
    this.input.on("focus", (_e, cx) => { this.inputFocused = true; cx.notify(); });
    this.input.on("blur", (_e, cx) => { this.inputFocused = false; cx.notify(); });
    this.input.on("submit", (_e, cx) => this.saveName(cx));
    this.input.focus();
    this.renameFocusTimer = cx.timer.after(600, () => {
      focusIfOpen(this.closed, () => this.input.focus());
    });
  }

  saveName(cx) {
    if (this.renameBusy) return;
    const p = props(), name = this.input.value().trim();
    if (!name && !this.renameClearConfirm) {
      this.renameClearConfirm = true;
      this.renameError = "";
      cx.notify();
      return;
    }
    if (name) {
      const error = validateEdit(p.name ?? "", name, p.siblings ?? []);
      if (error) { this.renameError = error; cx.notify(); return; }
    }
    this.renameBusy = true;
    this.renameError = "";
    cx.notify();
    cx.spawn(async (cx) => {
      const result = await commitName({
        address: p.address,
        name,
        currentName: p.name ?? "",
        source: "manual",
        label: async (address, values) => {
          const r = await hc(["label", address, ...Object.entries(values).map(([k, v]) => `${k}=${v}`)]);
          if (r.code !== 0) throw new Error("label write failed");
        },
        syncTab: async (next) => this.syncTab(p.address, next, cx),
      });
      this.renameBusy = false;
      if (this.closed) return;
      if (!result.ok) {
        this.renameError = result.error;
        cx.notify();
        return;
      }
      this.autoNameBlocked.add(p.address);
      if (result.tabSyncFailed) notify({ title: "任务名已保存", body: "标签页名称未同步", level: "warning" });
      closeOverlay(p.overlay);
      cx.notify();
    });
  }

  waitRename(cx, ms = 80) {
    if (this.closed) return Promise.resolve();
    return new Promise((resolve) => {
      let handle;
      const finish = () => {
        this.renameWaitTimers.delete(handle);
        this.renameWaitResolvers.delete(finish);
        resolve();
      };
      handle = cx.timer.after(ms, finish);
      this.renameWaitTimers.add(handle);
      this.renameWaitResolvers.add(finish);
    });
  }

  async syncTab(address, name, cx) {
    const plan = tabSyncPlan(panes(), agents().find(a => a.address === address), name);
    if (!plan) return;
    run("tab.rename", plan);
    // run 没有回执：有界等待宿主回显，区分“快照稍后更新”与真正未生效。
    const result = await waitForTabName({
      plan, name,
      read: (id) => spaces().flatMap(s => s.tabs ?? []).find(t => t.id === id),
      wait: () => this.waitRename(cx),
    });
    if (!result.ok) throw new Error("tab rename not echoed");
  }

  renameButton(address, t) {
    return h_flex().id(`rename-${address}`).w(16).h(16).flex_none().items_center().justify_center()
      .text_color(t.dim).opacity(1).tooltip("修改任务名").cursor_pointer()
      .on_click((_e, cx) => { cx.stop_propagation(); this.renameByAddress(address); })
      .child(svg("mods/agents-order/pencil.svg").size(14).text_color(t.dim));
  }

  renameByAddress(address) {
    const all = terminals();
    const info = agents().find(a => a.address === address);
    const term = all.find(t => t.address === address);
    const stored = displayName(term?.labels ?? {}, "");
    const fallback = term?.name || term?.template || term?.program?.name || term?.address || "";
    const name = stored || fallback;
    const parentSpace = term?.parent ? agents().find(a => a.address === term.parent)?.space : null;
    const space = info?.space || term?.labels?.["herdr.space"] || parentSpace;
    const siblings = [
      ...agents().filter(a => a.address !== address && (!space || a.space === space))
        .map(a => this.nameById?.get(a.address) || a.name || a.program?.name || ""),
      ...all.filter(t => t.address !== address && t.parent && (!space || agents().find(a => a.address === t.parent)?.space === space))
        .map(t => this.nameById?.get(t.address) || t.name || t.program?.name || ""),
    ].filter(Boolean);
    openOverlay({ mod: "agents-order", kind: "dialog", width: 340, props: { rename: true, address, name, siblings } });
  }

  renameView() {
    const t = theme(), p = props(), busy = this.renameBusy;
    const button = (id, text, primary, action) => h_flex().id(id).h(28).px(10).items_center().rounded(6)
      .border_1().border_color(primary ? t.solid : t.input).bg(primary ? t.solid : t.raised)
      .text_color(primary ? t.solid_foreground : t.foreground).text_size(11.5).font_medium().cursor_pointer()
      .hover(s => s.opacity(0.88)).on_click(action).child(text);
    return v_flex().id("rename-dialog").w_full().bg(t.popover).text_color(t.foreground)
      .track_focus(this.handle)
      .child(v_flex().p(14)
        .child(h_flex().items_center()
          .child(div().flex_1().text_size(13.5).font_semibold().child("修改任务名"))
          .child(div().text_size(10.5).text_color(t.dim).child("Esc")))
        .child(div().pt(3).text_size(10.5).text_color(t.dim).child("同一 Space 内不能重名；留空需再次确认清空"))
        .child(Input.new(this.input).h(32).px(9).rounded(7).text_size(12.5)
          .border_1().border_color(this.inputFocused ? t.accent : t.input).bg(t.background).text_color(t.foreground))
        .child(div().pt(6).h(16).text_size(10.5).text_color(this.renameError ? t.blocked : t.dim)
          .child(this.renameError || (this.renameClearConfirm ? "再次点击“确认清空”将移除任务名" : "")))
        .child(h_flex().pt(6).gap(6).items_center().justify_end()
          .child(button("cancel-name", "取消", false, () => closeOverlay(p.overlay)))
          .child(busy ? button("save-name", "保存中…", true, () => {}) : button("save-name", this.renameClearConfirm ? "确认清空" : "保存", true, (_e, cx) => this.saveName(cx)))));
  }

  // Stamps agents whose state changed. Done and idle count as one: looking at a
  // finished agent turns done into idle, and looking isn't the agent doing anything.
  track(list, now) {
    let dirty = false;
    for (const a of list) {
      const s = a.status === "done" ? "idle" : a.status;
      if (this.changed[a.address]?.s === s) continue;
      this.changed[a.address] = { s, at: now };
      dirty = true;
    }
    if (!dirty) return;
    // Gone and old: the list alone is empty right after a start.
    const listed = new Set(list.map((a) => a.address));
    for (const [k, c] of Object.entries(this.changed)) if (!listed.has(k) && now - c.at > 30 * 86400000) delete this.changed[k];
    localStorage.setItem("changed", JSON.stringify(this.changed));
  }

  // Keep offline pins until their terminal returns, and keep each pending until
  // core echoes the label so a failed write doesn't erase the old pin.
  migratePins(all) {
    const listed = new Map(all.filter((t) => t.state === "live").map((t) => [t.address, t]));
    const pending = this.pendingPins.filter((address) => {
      const terminal = listed.get(address);
      if (!terminal) return true;
      if (terminal.labels?.["herdr.pinned"]) return false;
      if (!this.migratingPins.has(address)) {
        this.migratingPins.add(address);
        run("terminal.pin", { terminal: address, pinned: true });
      }
      return true;
    });
    if (pending.length === this.pendingPins.length) return;
    this.pendingPins = pending;
    if (pending.length) localStorage.setItem("pins", JSON.stringify(pending));
    else localStorage.removeItem("pins");
  }

  since(a) {
    return this.changed[a.address]?.at ?? 0;
  }

  rank(a) {
    return RANK[a.status] ?? 0;
  }
  // 排序标签保存在 core；本地预览只覆盖标签异步回显的短暂窗口。
  grouped(list, all) {
    const ranks = Object.fromEntries(all.map(t => [t.address, t.labels?.["workbench.order"]]));
    return orderedBySpace(list, spaces().map(space => space.id), ranks, this.previews);
  }

  reconcile(list, all) {
    if (!this.previews.size) return;
    const ranks = Object.fromEntries(all.map(t => [t.address, t.labels?.["workbench.order"]]));
    for (const [space, preview] of this.previews) {
      const actual = orderedGroup(list.filter(a => a.space === space && !a.pinned), ranks);
      const same = actual.length === preview.ids.length && actual.every((a, i) => a.address === preview.ids[i]);
      if (same || (!this.busy.has(space) && Date.now() - preview.at > 2000)) this.previews.delete(space);
    }
  }

  beginDrag(a, members, index, all, e, cx) {
    if (this.busy.has(a.space) || members.length < 2) return;
    this.focusHandle.focus();
    const center = e.position.y - (e.local_position?.y ?? 15) + 15;
    const children = members.map(m => this.folded.has(m.address) ? 0 : this.tree(all, m.address).length);
    this.drag = { address: a.address, pane: a.pane, space: a.space, members, origin: index,
      target: index, start: e.position.y, y: e.position.y, valid: true,
      centers: rowCenters(index, center, children) };
    this.dragTimer?.cancel();
    let ticks = 0;
    this.dragTimer = cx.timer.every(16, cx => {
      if (!this.drag) return;
      const pos = globalThis.window?.mouse_position?.();
      if (pos) {
        const b = this.rootBounds;
        if (b && (pos.x < b.x || pos.x >= b.x + b.width || pos.y < b.y || pos.y >= b.y + b.height)) {
          this.cancelDrag(cx); return;
        }
        this.moveDrag(pos.y, cx);
      }
      if (++ticks % 8 === 0 && globalThis.window?.is_window_active?.() === false) this.cancelDrag(cx);
    });
    cx.notify();
  }

  moveDrag(y, cx) {
    if (!this.drag) return;
    const target = dropIndex(y, this.drag.centers);
    if (this.drag.y === y && this.drag.target === target) return;
    this.drag.y = y;
    this.drag.target = target;
    cx.notify();
  }

  cancelDrag(cx) {
    this.dragTimer?.cancel();
    this.dragTimer = null;
    this.drag = null;
    cx.notify();
  }

  finishDrag(cx) {
    const d = this.drag;
    if (!d) return;
    this.cancelDrag(cx);
    this.lastDragEnd = releaseTime(d, this.lastDragEnd ?? 0, Date.now());
    const current = new Map(agents().map(a => [a.address, a]));
    d.valid = sortOf().id === "grouped" && d.members.every(a => {
      const live = current.get(a.address);
      return live?.space === d.space && !live.pinned;
    });
    const outcome = dragDecision({ dy: d.y - d.start, origin: d.origin, target: d.target, valid: d.valid });
    if (outcome === "focus") { if (d.valid) run("pane.focus", { pane: d.pane }); return; }
    if (outcome !== "reorder") return;
    const ids = reorderGroup(d.members, d.address, d.target);
    if (ids) this.saveDrag(d.space, ids, cx);
  }

  // 逐个写入顺序；中途失败则回滚已写标签，失败阶段只记录终端地址。
  saveDrag(space, ids, cx) {
    const previous = Object.fromEntries(terminals().map(t => [t.address, t.labels?.["workbench.order"] ?? ""]));
    this.previews.set(space, { ids, at: Date.now() });
    this.busy.add(space);
    cx.spawn(async cx => {
      try {
        const result = await persistOrder(ids, previous, async (id, rank) => {
          const reply = await hc(["label", id, `workbench.order=${rank}`]);
          if (reply.code !== 0) throw new Error("label write failed");
        });
        if (!result.ok) {
          this.previews.delete(space);
          this.error = result.rollbackFailed.length
            ? `排序在 ${result.failedAt} 写入失败，${result.rollbackFailed.length} 条回滚也失败；请检查标签`
            : `排序在 ${result.failedAt} 写入失败，已还原；请重试`;
        } else this.error = "";
      } finally {
        this.busy.delete(space);
        cx.notify();
      }
    });
    cx.notify();
  }

  close() {
    this.closed = true;
    this.renameFocusTimer?.cancel();
    for (const handle of this.renameWaitTimers ?? []) handle?.cancel?.();
    for (const resolve of this.renameWaitResolvers ?? []) resolve();
    this.renameWaitTimers?.clear();
    this.renameWaitResolvers?.clear();
    this.dragTimer?.cancel();
    this.dragTimer = null;
    this.todoTimer?.cancel();
    this.todoNavTimer?.cancel();
    this.todoNavTimer = null;
    this.todo?.close();
    try { this.todoScroll?.release(); } catch { /* 已释放 */ }
    this.drag = null;
    this.previews?.clear();
  }


  sortMenu(t) {
    const on = sortOf().id;
    return v_flex()
      .w_full()
      .p(5)
      .bg(t.popover)
      .text_size(12.8)
      .child(div().px(8).pt(4).pb(6).text_size(11).text_color(t.dim).child("Sort agents"))
      .children(SORTS.map((s) => h_flex()
        .id(`sort-${s.id}`)
        .h(31)
        .px(8)
        .gap(9)
        .rounded(7)
        .items_center()
        .text_color(t.foreground)
        .hover((el) => el.bg(t.hover))
        .on_click(() => {
          setShared("agents.sort", s.id);
          closeOverlay(props().overlay);
        })
        .child(svg(`mods/workspace-chrome/${s.icon}.svg`).size(14).flex_none().text_color(t.muted))
        .child(div().flex_1().child(s.label))
        .when(s.id === on, (el) => el.child(svg("mods/workspace-chrome/check.svg").size(14).flex_none().text_color(t.foreground)))));
  }

  peek(addr) {
    run("terminal.peek", { terminal: addr });
  }

  // Live sub-agents of `addr`, depth first, each with the tree lines in front of it.
  tree(all, addr, lead = []) {
    const kids = all.filter((k) => k.parent === addr && k.state === "live");
    return kids.flatMap((k, i) => {
      const last = i === kids.length - 1;
      return [
        { t: k, lines: [...lead, last ? "└" : "├"] },
        ...this.tree(all, k.address, [...lead, last ? "" : "│"]),
      ];
    });
  }

  subRow(t, s, shown, compact) {
    const k = s.t;
    const st = kidStatus(k, this.listed);
    const pic = icon(k.program, 14, t.foreground);
    const on = k.address === shown;
    return h_flex()
      .id(`sub-${k.address}`)
      .pl(39)
      .pr(8)
      .rounded(8)
      .h(26)
      .flex_none()
      .gap(0)
      .items_center()
      .text_size(12.5)
      .when(on, (el) => el.bg(t.raised))
      .hover((s) => s.bg(t.hover))
      .on_hover((active, cx) => { this.hovered = active ? k.address : (this.hovered === k.address ? null : this.hovered); cx.notify(); })
      .on_click(() => (this.listed.has(k.address) ? run("pane.focus", { terminal: k.address }) : this.peek(k.address)))
      .children(s.lines.map(l => div().self_start().mt(-4).w(9).h(17).mr(4).flex_none()
        .when(Boolean(l), el => el.border_l(1.5).border_color(t.input))
        .when(l === "└" || l === "├", el => el.border_b(1.5).rounded_bl(6))))
      .when(Boolean(pic), el => el.child(div().mr(8).child(pic)))
      .child(div().flex_1().min_w(0).truncate().tooltip(this.nameById?.get(k.address) || k.name || k.template || k.program?.name || k.address)
        .text_color(on ? t.foreground : t.muted)
        .child(this.nameById?.get(k.address) || k.name || k.template || k.program?.name || k.address))
      .when(this.hovered === k.address, (el) => el.child(this.renameButton(k.address, t)))
      .child(this.subStatus(t, k, st));
  }

  agentState(a) {
    return agentIconState(a, this.todoState?.items ?? [], this.todoVerified ?? {});
  }

  // 子 Agent 用自身 address 关联事项，保留产品 icon/树结构，不串父行状态。
  subStatus(t, k, st) {
    return statusIcon(subAgentState(k, st, this.todoState?.items ?? [], this.todoVerified ?? {}), t);
  }

  // Agents 行与待办行复用同一套 14px 状态图标；图标只表达状态，不改排序。
  status(t, a) {
    return statusIcon(a?.address ? this.agentState(a) : a?.status, t);
  }

  render(cx) {
    const t = theme();
    if (props()?.sortMenu) return this.sortMenu(t);
    if (props()?.rename) return this.renameView();
    const collapsed = narrow();
    const sort = sortOf();
    let list = agents();
    this.listed = new Map(list.map((a) => [a.address, a.status]));
    const all = terminals();
    this.nameById = new Map(all.map(t => [t.address, displayName(t.labels ?? {}, "")]));
    if (!checking()) this.scanAutoNames(all, cx);
    this.migratePins(all);
    const shown = focused()?.agent;
    const now = Date.now();
    this.track(list, now);
    // A kept sub-agent (one with a pane) is in agents() too: where a tree shows
    // it, it gets no row of its own, unless it's pinned.
    const nested = new Set(collapsed ? [] : list.flatMap((a) => this.tree(all, a.address).map((s) => s.t.address)));
    list = list.filter((a) => a.pinned || !nested.has(a.address));
    const tabCounts = new Map();
    for (const a of list) tabCounts.set(a.tab, (tabCounts.get(a.tab) ?? 0) + 1);
    const byPriority = sort.id === "priority";
    const urgency = new Map(list.map((a) => [a.address, Math.max(this.rank(a), ...this.tree(all, a.address).map((s) => RANK[kidStatus(s.t, this.listed)] ?? 0))]));
    const rankOf = (a) => urgency.get(a.address);
    if (byPriority) list = [...list].sort((x, y) => rankOf(y) - rankOf(x) || this.since(y) - this.since(x) || y.seq - x.seq);
    else {
      this.reconcile(list, all);
      list = this.grouped(list, all);
    }
    const pinned = list.filter((a) => a.pinned);
    const rest = list.filter((a) => !a.pinned);
    list = [...pinned, ...rest];
    setAgentOrder(list.map((a) => a.address));
    if (this.mode === "todo") return this.todoShell(t);

    const withKids = (a, i, members) => {
      const subs = collapsed ? [] : this.tree(all, a.address);
      const r = row(a, i, subs, members);
      if (this.folded.has(a.address)) return [r];
      return [r, ...subs.map((s) => this.subRow(t, s, shown, byPriority))];
    };

    // The fold chevron; folded, the count too, colored by the most urgent one.
    const fold = (a, subs) => {
      const sts = subs.map((s) => kidStatus(s.t, this.listed));
      const top = sts.reduce((m, s) => ((RANK[s] ?? 0) > (RANK[m] ?? 0) ? s : m), null);
      const open = !this.folded.has(a.address);
      return div()
        .id(`fold-${a.address}`)
        .h(18)
        .px(3)
        .gap(3)
        .flex()
        .items_center()
        .rounded(4)
        .text_size(11)
        .text_color(open ? t.dim : (t[top] ?? t.dim))
        .cursor_pointer()
        .hover((s) => s.bg(t.hover).text_color(t.foreground))
        .on_click((_e, cx) => {
          cx.stop_propagation();
          open ? this.folded.add(a.address) : this.folded.delete(a.address);
          cx.notify();
        })
        .child(svg(`mods/workspace-chrome/chevron-${open ? "down" : "right"}.svg`).size(11).flex_none())
        .when(!open, (el) => el.child(String(subs.length)));
    };

    // A row reads "space \u00b7 detail": the detail is a tab someone named or the
    // agent's own title, never an automatic tab number unless two rows would
    // otherwise read the same.
    // Read the pane snapshot once: every host read copies the whole list into JS.
    const leads = leadPanes(panes());
    const tabs = new Map(spaces().flatMap(s => s.tabs).map(tab => [tab.id, tab]));
    const labels = new Map(list.map(a => {
      const tab = tabs.get(a.tab);
      const many = tabCounts.get(a.tab) > 1;
      return [a.address, tab ? title(many ? { ...tab, named: false } : tab, many ? a : leads.get(a.tab)) : (a.title || a.program?.name || "")];
    }));
    const label = (a) => labels.get(a.address);
    const detail = new Map(list.map(a => [a.address, /^\d+$/.test(label(a)) ? null : label(a)]));
    const seen = {};
    for (const a of list) { const k = `${a.space_name}\u0000${detail.get(a.address) ?? ""}`; seen[k] = (seen[k] ?? 0) + 1; }
    for (const a of list) {
      if (detail.get(a.address) == null && seen[`${a.space_name}\u0000`] > 1) detail.set(a.address, label(a));
    }

    const row = (a, i, subs = [], members = []) => {
      const pic = icon(a.program, 16, t.foreground);
      const more = detail.get(a.address);
      // An agent on another machine (`vps/t7`) says which.
      const machine = a.address.includes("/") ? a.address.split("/")[0] : null;
      if (collapsed) {
        return h_flex()
          .id(`ag-${a.address}`)
          .h(26)
          .px(8)
          .flex_none()
          .items_center()
          .gap(4)
          .hover((s) => s.bg(t.hover))
          .on_click(() => run("pane.focus", { pane: a.pane }))
          .child(div().flex_1().min_w(0).whitespace_nowrap().text_right().text_color(t.muted).child(String(i + 1)))
          .child(h_flex().w(14).flex_none().items_center().justify_center().child(this.status(t, a, true)));
      }
      const when = this.since(a);
      const idle = a.status === "idle" && !a.focused;
      const isPinned = a.pinned;
      const pin = div()
        .id(`pin-${a.address}`)
        .flex_none()
        .p(2)
        .rounded(4)
        .text_color(t.dim)
        .cursor_pointer()
        .hover((s) => s.bg(t.hover).text_color(t.foreground))
        .tooltip(isPinned ? "Unpin" : "Pin to the top")
        .on_click((_e, cx) => {
          cx.stop_propagation();
          run("terminal.pin", { terminal: a.address, pinned: !isPinned });
          // The row moves away from under the pointer, and no hover-out comes.
          this.hovered = null;
          cx.notify();
        })
        .child(svg(`mods/workspace-chrome/${isPinned ? "pin-off" : "pin"}.svg`).size(13));
      // Under a space header the space goes without saying; an automatic tab number says nothing.
      // Without a space header above (priority, pinned) the row names its space.
      const full = byPriority || isPinned;
      const storedName = this.nameById?.get(a.address) || "";
      const fallbackName = full ? a.space_name || label(a) : more ?? (/^\d+$/.test(label(a)) ? a.program?.name || label(a) : label(a));
      const name = storedName || fallbackName;
      return h_flex()
        .id(`ag-${a.address}`)
        .px(8)
        .h(30)
        .flex_none()
        .rounded(8)
        .items_center()
        .gap(9)
        .when(a.focused, (el) => el.bg(t.selected))
        .cursor_pointer()
        .hover((s) => s.bg(t.hover))
        .on_hover((on, cx) => {
          if (on) this.hovered = a.address;
          else if (this.hovered === a.address) this.hovered = null;
          cx.notify();
        })
        .when(this.drag?.address === a.address, el => el.opacity(0.35))
        .when(this.drag?.space === a.space && this.drag?.target === i && this.drag?.address !== a.address && !isPinned,
          el => el.border_1().border_color(t.accent))
        .on_click(() => { if (Date.now() - (this.lastDragEnd ?? 0) > 300) run("pane.focus", { pane: a.pane }); })
        .when(!byPriority && !isPinned && members.length > 1, el => el.child(
          h_flex().id(`drag-${a.address}`).w(17).h_full().flex_none().items_center().justify_center()
            .cursor_grab().tooltip("按住拖动排序")
            .on_mouse_down("left", (e, cx) => this.beginDrag(a, members, i, all, e, cx))
            .child(svg("mods/agents-order/grip.svg").size(13).text_color(t.dim))))
        .when(Boolean(pic), el => el.child(div().id(`agent-fold-${a.address}`)
          .when(subs.length > 0, el => el.on_click((_e, cx) => {
            cx.stop_propagation();
            this.folded.has(a.address) ? this.folded.delete(a.address) : this.folded.add(a.address);
            cx.notify();
          })).child(pic)))
        .child(h_flex().flex_1().min_w(0).gap(5).items_center()
          .child(div().min_w(0).max_w(full && more ? 120 : 200).truncate().tooltip(name).text_color(idle ? t.muted : t.foreground).child(name))
          .when(full && Boolean(more), el => el.child(div().flex_1().min_w(0).truncate().text_color(t.dim).child(`\u00b7 ${more}`))))
        .when(Boolean(machine), el => el.child(div().text_size(10).text_color(t.dim).child(machine)))
        .when(subs.length > 0, el => el.child(fold(a, subs)))
        .when(this.hovered === a.address, el => el.child(this.renameButton(a.address, t)))
        .when(this.hovered === a.address, el => el.child(pin))
        .when(this.hovered !== a.address && Boolean(when), el => el.child(div().flex_none().text_size(11).text_color(t.dim).child(duration(now - when))))
        .child(this.status(t, a, byPriority && !isPinned));
    };

    // Groups in list order: spaces (grouped) or priority sections. Agents of a
    // space are next to each other in agents(), so neighbours make a group.
    const groups = pinned.length ? [{ id: "pinned", label: "Pinned", status: null, members: pinned }] : [];
    for (const a of rest) {
      const r = rankOf(a) || RANK.idle;
      const id = byPriority ? `sec-${r}` : `sp-${a.space}`;
      if (groups.at(-1)?.id === id) groups.at(-1).members.push(a);
      else groups.push({ id, label: byPriority ? SECTION[r] : a.space_name || "", status: byPriority ? SECTION_STATUS[r] : null, members: [a] });
    }

    // A group's header; it folds the group. Folded, it says how many and the most urgent state.
    const header = (g) => {
      const open = !this.folded.has(g.id);
      const top = g.members.reduce((m, a) => ((RANK[a.status] ?? 0) > (RANK[m] ?? 0) ? a.status : m), null);
      return h_flex()
        .id(g.id)
        .px(8)
        .pt(8)
        .h(30)
        .flex_none()
        .gap(6)
        .items_center()
        .text_size(11)
        .font_medium()
        .cursor_pointer()
        .hover((s) => s.text_color(t.foreground))
        .on_click((_e, cx) => {
          open ? this.folded.add(g.id) : this.folded.delete(g.id);
          cx.notify();
        })
        .child(div().truncate().text_color(t[g.status] ?? t.dim).child(g.label))
        .when(byPriority || !open, (el) => el.child(div().text_color(t.dim).child(String(g.members.length))))
        .child(div().flex_1())
        .when(!open, (el) => el
          .when(!byPriority && top && top !== "idle", (el) => el.child(this.status(t, { status: top }, true)))
          .child(svg("mods/workspace-chrome/chevron-right.svg").size(11).flex_none().text_color(t.dim)));
    };
    const groupRows = g => {
      if (byPriority || g.id === "pinned") return g.members.flatMap((a, i) => withKids(a, i, g.members));
      const heights = Object.fromEntries(g.members.map(a => [
        a.address, 30 + (this.folded.has(a.address) ? 0 : this.tree(all, a.address).length * 26),
      ]));
      const drag = this.drag?.space === g.members[0]?.space ? this.drag : null;
      const positions = projectedPositions(g.members, drag?.address, drag?.target, heights);
      let total = 0;
      for (const height of Object.values(heights)) total += height;
      return [v_flex().relative().w_full().h(total)
        .children(g.members.map((a, i) => v_flex().id(`agent-block-${a.address}`)
          .absolute().left(0).right(0).top(positions.get(a.address)).h(heights[a.address])
          .transition("top", 160).children(withKids(a, i, g.members))))];
    };
    const rows = collapsed
      ? list.flatMap(withKids)
      : groups.flatMap((g) => [header(g), ...(this.folded.has(g.id) ? [] : groupRows(g))]);

    return v_flex()
      .relative()
      .track_focus(this.focusHandle)
      .on_mouse_down("left", (e) => { if (e.bounds) this.rootBounds = e.bounds; })
      .on_mouse_move((e, cx) => { if (e.bounds) this.rootBounds = e.bounds; if (this.drag) this.moveDrag(e.position.y, cx); })
      .on_mouse_up("left", (_e, cx) => this.finishDrag(cx))
      .on_mouse_down_out((_e, cx) => { if (this.drag) this.cancelDrag(cx); })
      .on_key_down((e, cx) => { if (e.key === "escape" && this.drag) this.cancelDrag(cx); })
      .size_full()
      .min_h(0)
      .bg(t.chrome)
      .border_t(1)
      .border_color(t.border)
      .text_size(13)
      .when(!collapsed, (el) => el.child(this.modeHeaderView(t, sort)))
      .when(list.length === 0 && !collapsed, (el) =>
        el.child(div().px(12).text_size(12).text_color(t.dim).child("No agent status yet. Agents show up here when they report their status. Older versions and agents inside tmux may not.")),
      )
      .when(this.error, el => el.child(div().px(12).py(4).text_size(11).text_color(t.blocked).child(this.error)))
      .child(v_flex().id("ag-list").flex_1().min_h(0).px(collapsed ? 0 : 8).overflow_y_scrollbar().mode("always").children(rows))
      .when(collapsed, (el) =>
        el.child(
          h_flex()
            .h(28)
            .items_center()
            .justify_center()
            .child(
              div()
                .id("collapse")
                .text_size(13)
                .text_color(t.dim)
                .hover((s) => s.text_color(t.foreground))
                .on_click(toggleSidebar)
                .child("»"),
            ),
        ),
      )
      .when(this.drag, el => el.child(div().id("drag-layer").absolute().inset(0).w_full().h_full()
        .on_mouse_move((e, cx) => this.moveDrag(e.position.y, cx))
        .on_mouse_up("left", (_e, cx) => this.finishDrag(cx))
        .on_click((_e, cx) => cx.stop_propagation())
        .child(h_flex().absolute().left(8).right(8)
          .top(this.drag.y - (this.rootBounds?.y ?? 0) - 15).h(30).px(8).gap(9)
          .items_center().rounded(8).bg(t.raised).border_1().border_color(t.accent).shadow_2xl()
          .child(svg("mods/agents-order/grip.svg").size(13).text_color(t.accent))
          .child(div().truncate().text_color(t.foreground).child(detail.get(this.drag.address) ?? "Agent")))));
  }
}

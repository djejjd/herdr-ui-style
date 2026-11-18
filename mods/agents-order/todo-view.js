// 待办视图：标题分段、行、空/错误/冲突态。只消费 todo.js 的视图模型。
import { div, svg } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { todoBadge } from "./todo.js";

// 统一 14px 细线图标：运行态中性，review 用 accent，needs_user 用提醒色，
// blocked/conflict 只用小图标承载错误色；行文字保持正常前景。
export function statusIcon(state, t) {
  if (state === "working" || state === "operation") {
    return svg("mods/workspace-chrome/spinner.svg").size(14).flex_none().text_color(t.muted).spin(900);
  }
  if (state === "needs_user") return svg("mods/agents-order/user.svg").size(14).flex_none().text_color(t.working);
  if (state === "review") return svg("mods/agents-order/review.svg").size(14).flex_none().text_color(t.accent);
  if (state === "blocked" || state === "conflict") return svg("mods/agents-order/blocked.svg").size(14).flex_none().text_color(t.blocked);
  return svg("mods/agents-order/idle.svg").size(14).flex_none().text_color(t.dim);
}

function tab(id, label, active, t, action) {
  return div().id(id).h(24).px(4).flex().items_center().text_size(11.5).font_medium()
    .text_color(active ? t.foreground : t.dim)
    .cursor_pointer().hover(s => s.text_color(t.foreground))
    .on_click((_e, cx) => action(cx)).child(label);
}

export function modeHeader(t, mode, badge, actions) {
  const count = badge?.kind === "count" ? badge.text : badge?.kind === "error" ? "!" : badge?.kind === "loading" ? "…" : null;
  const left = h_flex().items_center().gap(8)
    .child(tab("mode-agents", "Agents", mode === "agents", t, actions.agents))
    .child(h_flex().items_center().gap(4)
      .child(tab("mode-todo", "待办", mode === "todo", t, actions.todo))
      .when(Boolean(count), el => el.child(div()
        .h(14).min_w(14).px(3).flex().items_center().justify_center().rounded(4)
        .bg(t.selected).text_size(10).text_color(t.muted)
        .child(count))));
  return h_flex().px(16).h(41).pt(14).pb(5).flex_none().items_center().justify_between()
    .child(left)
    .child(actions.right ?? div().w(14).h(14));
}

export function todoRow(item, t, { selected, failure, onOpen }) {
  const bad = item.displayState === "conflict" || item.displayState === "invalid";
  const actionable = !bad && !item.legacy;
  const second = failure?.id === item.id || failure?.id === item.key
    ? failure.reason
    : item.conflict ? `冲突 ${item.conflictCount} 条，需监督方修正` : item.sourceLabel;
  return h_flex().id(`todo-${item.key}`).relative().h(30).flex_none().px(8).gap(9).rounded(8).items_center()
    .when(selected, el => el.bg(t.selected))
    .when(selected, el => el.child(div().absolute().left(0).top(7).bottom(7).w(2).rounded(1).bg(t.accent)))
    .when(!selected, el => el.hover(s => s.bg(t.hover)))
    .when(actionable, el => el.cursor_pointer().on_click((_e, cx) => { cx.stop_propagation(); onOpen(item, cx); }))
    .tooltip(item.evidence ? `${item.sourceLabel} · ${item.evidence}` : item.sourceLabel)
    .child(statusIcon(item.displayState, t))
    .child(v_flex().flex_1().min_w(0).gap(1)
      .child(div().min_w(0).truncate().text_size(12.5).line_height("14px")
        .text_color(t.foreground).child(item.title))
      .child(div().min_w(0).truncate().text_size(10.5).line_height("12px")
        .text_color(t.muted).child(second)))
    .when(item.conflict, el => el.child(div().flex_none().text_size(10).text_color(t.dim).child(`×${item.conflictCount}`)))
    .when(!actionable && !item.conflict, el => el.child(div().flex_none().text_size(10).text_color(t.dim).child("只读")));
}

export function todoNotice(text, t, level = "dim") {
  return div().px(12).py(8).text_size(11.5).text_color(t.muted).child(text);
}

export function todoBody(t, state, selected, failure, onOpen, scroll) {
  const rows = (state?.items ?? []).map(item => todoRow(item, t, { selected, failure, onOpen }));
  const errors = state?.errors?.length ? todoNotice(`记录错误 ${state.errors.length} 条，需监督方修正`, t, "error") : null;
  const head = state?.kind === "loading" ? todoNotice("待办读取中…", t)
    : state?.kind === "missing" ? todoNotice("待办账本缺失，无法读取（不是 0 条）", t, "error")
      : state?.kind === "error" ? todoNotice("待办账本读取失败（不是 0 条）", t, "error")
        : state?.kind === "stale" ? [todoNotice("账本读取失败，显示上次结果", t, "error"), ...(errors ? [errors] : []), ...rows]
          : rows.length ? [ ...(errors ? [errors] : []), ...rows] : [ ...(errors ? [errors] : []), todoNotice("没有待办", t)];
  return v_flex().id("ag-list").flex_1().min_h(0).px(8).overflow_y_scrollbar().mode("always")
    .track_scroll(scroll)
    .children(Array.isArray(head) ? head : [head]);
}

export function todoRefreshIcon(t, action) {
  return div().id("todo-refresh").text_size(11).text_color(t.dim)
    .hover(s => s.text_color(t.foreground)).cursor_pointer().tooltip("重新读取待办账本")
    .on_click((_e, cx) => action(cx)).child(svg("mods/agents-order/refresh.svg").size(14));
}



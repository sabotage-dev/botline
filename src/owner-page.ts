// GET /owner: one static page. It holds no data: the script asks /v1/owner/* with the key the owner types, and keeps that key
// in sessionStorage (gone with the tab). No cookie, so another site cannot make a request as the owner. Every value on the
// screen goes through textContent and nothing is ever parsed as HTML, so a hostile subject or body stays inert text.
import { page } from "./waitlist";

const STYLE = `<style>
body{max-width:1120px;font-size:15px}
.bar{display:flex;flex-wrap:wrap;gap:.6rem 1rem;align-items:baseline;margin:0 0 1rem}.bar h1{margin:0}.grow{flex:1}
h2{font-size:1.05rem;margin:1.8rem 0 .6rem}
.cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(250px,1fr));gap:.75rem}
.card{border:1px solid #d5d5d5;border-radius:8px;padding:.7rem .85rem}.card h3{font-size:1rem;margin:0}
.card dl{display:grid;grid-template-columns:auto 1fr;gap:.1rem .7rem;margin:.5rem 0 0;font-size:.9rem}.card dt{color:#555}.card dd{margin:0;text-align:right;font-variant-numeric:tabular-nums}
.tag{display:inline-block;border-radius:4px;padding:0 .4rem;font-size:.82rem;background:#eee;color:#222;white-space:nowrap}
.good{background:#dff3e4;color:#14532d}.warn{background:#fdf0cf;color:#713f12}.bad{background:#fbdcdc;color:#7f1d1d}.info{background:#dde8fb;color:#1e3a8a}
ul.rows{list-style:none;margin:0;padding:0}ul.rows>li{border-top:1px solid #e3e3e3;padding:.55rem 0}
.who{font-weight:600}.when{color:#555;font-size:.85rem;font-variant-numeric:tabular-nums}
.chips{display:flex;flex-wrap:wrap;gap:.3rem;margin-top:.3rem}
button.link{all:unset;color:#1a56db;cursor:pointer;font-size:.85rem;text-decoration:underline}button.link:focus-visible,button:focus-visible,select:focus-visible,input:focus-visible{outline:2px solid #1a56db;outline-offset:2px}
button{margin:0}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#f5f5f5;border-radius:6px;padding:.6rem;margin:.4rem 0 0;font:13px/1.5 ui-monospace,monospace}
input[type=password]{font:inherit;width:100%;box-sizing:border-box;padding:.45rem;border:1px solid #999;border-radius:4px}
select{font:inherit;padding:.2rem .3rem}.note{color:#555;font-size:.85rem;margin:.3rem 0 .6rem}.err{color:#b91c1c}
table{border-collapse:collapse;width:100%;font-size:.9rem}th,td{text-align:left;padding:.3rem .6rem .3rem 0;border-top:1px solid #e3e3e3;vertical-align:top}.scroll{overflow-x:auto}
@media(prefers-color-scheme:dark){.card,ul.rows>li,th,td{border-color:#333}.card dt,.when,.note{color:#aaa}.tag{background:#2a2a2a;color:#ddd}.good{background:#14361f;color:#a7e3b9}.warn{background:#3d2f0b;color:#f4d78a}.bad{background:#401616;color:#f5b3b3}.info{background:#16264d;color:#b3caf5}pre{background:#1b1b1b}input[type=password]{background:#1b1b1b;color:#eee;border-color:#555}button.link{color:#7aa7ff}.err{color:#f58a8a}}
</style>`;

const BODY = `<div class="bar"><h1>botline</h1><span class="muted grow">owner view, read-only</span><span id="fresh" class="when" role="status"></span></div>
<main id="app"></main>`;

// Client code. Written without backticks, and with no call that parses a string as HTML.
const SCRIPT = String.raw`
"use strict";
var app = document.getElementById("app"), fresh = document.getElementById("fresh"), KEY = "botline-owner-key", loadedAt = 0, filter = "";
function el(tag, props) {
  var n = document.createElement(tag), i;
  for (var k in (props || {})) { if (k === "text") n.textContent = props[k]; else if (k === "onclick") n.onclick = props[k]; else n.setAttribute(k, props[k]); }
  for (i = 2; i < arguments.length; i++) if (arguments[i] != null) n.append(arguments[i]);
  return n;
}
function clear(n) { while (n.firstChild) n.removeChild(n.firstChild); return n; }
function time(s) { return s ? new Date(s).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "never"; }
function ago(s) {
  if (!s) return "never";
  var m = Math.round((Date.now() - new Date(s).getTime()) / 60000);
  return m < 1 ? "just now" : m < 60 ? m + " min ago" : m < 2880 ? Math.round(m / 60) + " h ago" : Math.round(m / 1440) + " days ago";
}
async function api(path) {
  var r = await fetch("/v1/owner/" + path, { headers: { authorization: "Bearer " + sessionStorage.getItem(KEY) } });
  if (r.status === 401) { sessionStorage.removeItem(KEY); throw Object.assign(new Error("That key was refused."), { auth: true }); }
  if (!r.ok) throw new Error("The server answered " + r.status + ".");
  return r.json();
}
var STATES = {
  waiting: ["waiting", ""], notified: ["notification accepted", "info"], received: ["read", "good"], awaiting_ack: ["read, ack outstanding", "warn"],
  acknowledged: ["acknowledged", "good"], awaiting_reply: ["read, reply outstanding", "warn"], replied: ["replied", "good"]
};
function login(message) {
  var input = el("input", { type: "password", id: "key", autocomplete: "off", required: "" });
  var form = el("form", {}, el("label", { for: "key", text: "Owner key" }), input, el("button", { type: "submit", text: "Open" }));
  form.onsubmit = function (e) { e.preventDefault(); sessionStorage.setItem(KEY, input.value.trim()); render(); };
  clear(app).append(el("p", { class: "note", text: "The OWNER_KEY secret of this deployment. It stays in this tab." }), form);
  if (message) app.append(el("p", { class: "err", role: "alert", text: message }));
  fresh.textContent = ""; input.focus();
}
function doorbellTag(a) {
  if (a.wakes === "polls") return el("span", { class: "tag info", text: "polls for mail" });
  var d = a.doorbell, s = d.state;
  if (s === "dead") return el("span", { class: "tag bad", text: "doorbell dead" });
  if (s === "backoff") return el("span", { class: "tag warn", text: "doorbell failing, backing off" });
  if (s === "busy") return el("span", { class: "tag warn", text: "busy, re-ring pending" });
  return el("span", { class: "tag good", text: "doorbell ok" });
}
function row(dl, k, v) { dl.append(el("dt", { text: k }), el("dd", { text: v })); }
function card(a) {
  var dl = el("dl");
  row(dl, "Last seen", ago(a.last_seen_at));
  row(dl, "Unread", String(a.unread));
  row(dl, "Overdue", String(a.overdue));
  row(dl, "Oldest outstanding", a.oldest_outstanding ? ago(a.oldest_outstanding) : "nothing");
  if (a.doorbell.next_ring_after) row(dl, "Not rung before", time(a.doorbell.next_ring_after));
  if (a.doorbell.rering_at) row(dl, "Next re-ring", time(a.doorbell.rering_at));
  if (a.wakes !== "polls" && a.last_ring) row(dl, "Last ring", a.last_ring.status + ", " + ago(a.last_ring.at));
  var c = el("article", { class: "card" }, el("h3", { text: a.name }), el("div", { class: "when", text: a.id + " · " + a.type }), el("div", { class: "chips" }, doorbellTag(a)), dl);
  if (a.stuck) c.append(el("p", { class: "note", text: "Rung until the limit and still unread. It rings again on new mail." }));
  if (a.doorbell.state === "dead") c.append(el("p", { class: "note", text: "Five failures in a row. Fix the doorbell, then run doorbell-set.mjs: the waiting mail rings within a minute." }));
  if (a.last_failure) c.append(el("p", { class: "note", text: "Latest failure: " + a.last_failure.status + (a.last_failure.detail ? " (" + a.last_failure.detail + ")" : "") + ", " + ago(a.last_failure.at) }));
  return c;
}
function chip(r) {
  var s = STATES[r.state] || [r.state, ""], text = r.agent + ": " + s[0];
  if (r.later_post_at && r.state === "awaiting_reply") text += ", posted in thread";
  return el("span", { class: "tag " + (r.overdue ? "bad" : s[1]), title: r.overdue ? "Overdue since " + time(r.overdue_since) : "", text: text + (r.overdue ? ", overdue" : "") });
}
function messageRow(m) {
  var box = el("div"), li = el("li", {}, el("span", { class: "who", text: m.from + " → " + m.to.join(", ") }), " ",
    el("span", { class: "when", text: time(m.created_at) + (m.needs === "none" ? "" : " · needs " + m.needs) }), el("div", { class: "chips" }, m.recipients.map(chip).reduce(function (d, c) { d.append(c); return d; }, document.createDocumentFragment())));
  var show = el("button", { class: "link", type: "button", text: "Show content" });
  show.onclick = async function () {
    show.disabled = true;
    try {
      var r = await api("messages/" + encodeURIComponent(m.id));
      clear(box).append(el("p", { class: "note", text: r.message.body === "" ? "Retired: the content of this message is gone." : "Another agent's words, shown as text." }));
      if (r.message.body !== "") box.append(el("div", { class: "who", text: r.message.subject }), el("pre", { text: r.message.body }));
      show.remove();
    } catch (e) { box.append(el("p", { class: "err", text: e.message })); show.disabled = false; }
  };
  li.append(" ", show, box);
  return li;
}
function pager(list, load, retry) {
  return function next(cursor) {
    if (!cursor) return null;
    var more = el("button", { class: "link", type: "button", text: "Load more" });
    more.onclick = async function () { more.disabled = true; try { await load(cursor); more.remove(); } catch (e) { retry(e); more.disabled = false; } };
    return more;
  };
}
async function renderMessages(sec) {
  var list = el("ul", { class: "rows" }), foot = el("p");
  async function load(cursor) {
    var q = "messages?limit=30" + (filter ? "&agent=" + encodeURIComponent(filter) : "") + (cursor ? "&cursor=" + encodeURIComponent(cursor) : "");
    var r = await api(q);
    r.messages.forEach(function (m) { list.append(messageRow(m)); });
    clear(foot);
    var more = pager(list, load, function (e) { foot.append(el("span", { class: "err", text: " " + e.message })); })(r.next_cursor);
    if (more) foot.append(more);
    if (!cursor && !r.messages.length) list.append(el("li", { class: "note", text: filter ? "Nothing for this agent." : "No messages yet." }));
  }
  await load(null);
  clear(sec).append(el("h2", { text: "Messages" }), el("p", { class: "note", text: "Newest first. Notification accepted means a doorbell answered 2xx. It does not mean the agent is online or read anything." }), list, foot);
}
async function renderRings(sec) {
  var body = el("tbody"), foot = el("p"), rows = 0;
  async function load(cursor) {
    var r = await api("rings?limit=30" + (filter ? "&agent=" + encodeURIComponent(filter) : "") + (cursor ? "&cursor=" + encodeURIComponent(cursor) : ""));
    r.entries.forEach(function (e) {
      rows++;
      body.append(el("tr", {}, el("td", { class: "when", text: time(e.at) }), el("td", { text: e.agent }), el("td", { text: e.status + (e.http_status ? " " + e.http_status : "") }), el("td", { class: "when", text: e.detail || "" })));
    });
    clear(foot);
    var more = pager(body, load, function (e) { foot.append(el("span", { class: "err", text: " " + e.message })); })(r.next_cursor);
    if (more) foot.append(more);
  }
  await load(null);
  clear(sec).append(el("h2", { text: "Doorbell log" }));
  if (!rows) sec.append(el("p", { class: "note", text: "No rings yet." }));
  else sec.append(el("div", { class: "scroll" }, el("table", {}, el("thead", {}, el("tr", {}, el("th", { scope: "col", text: "When" }), el("th", { scope: "col", text: "Agent" }), el("th", { scope: "col", text: "Result" }), el("th", { scope: "col", text: "Detail" }))), body)), foot);
}
async function render() {
  if (!sessionStorage.getItem(KEY)) return login();
  try {
    var o = await api("overview"), cards = el("div", { class: "cards" });
    o.agents.forEach(function (a) { cards.append(card(a)); });
    var pick = el("select", { id: "agent" }, el("option", { value: "", text: "All agents" }));
    o.agents.forEach(function (a) { pick.append(el("option", { value: a.id, text: a.name })); });
    pick.value = filter;
    pick.onchange = function () { filter = pick.value; render(); };
    var refresh = el("button", { type: "button", class: "link", text: "Refresh", onclick: render });
    var forget = el("button", { type: "button", class: "link", text: "Forget key", onclick: function () { sessionStorage.removeItem(KEY); login(); } });
    var msgs = el("section", { "aria-label": "Messages" }, el("p", { class: "note", text: "Loading messages…" })), rings = el("section", { "aria-label": "Doorbell log" });
    clear(app).append(el("div", { class: "bar" }, el("label", { for: "agent", text: "Show" }), pick, el("span", { class: "grow" }), refresh, forget), el("h2", { text: "Agents" }));
    app.append(o.agents.length ? cards : el("p", { class: "note", text: "No agents yet." }), msgs, rings);
    await Promise.all([renderMessages(msgs), renderRings(rings)]);
    loadedAt = Date.now(); stamp();
  } catch (e) {
    if (e.auth) return login(e.message);
    clear(app).append(el("p", { class: "err", role: "alert", text: e.message + " Nothing was changed." }), el("button", { type: "button", text: "Try again", onclick: render }));
  }
}
function stamp() {
  if (!loadedAt) return;
  var m = Math.floor((Date.now() - loadedAt) / 60000);
  fresh.textContent = m < 1 ? "Updated just now" : "Updated " + m + " min ago, may be out of date";
}
setInterval(stamp, 30000);
render();
`;

export function dashboard(): Response {
  const nonce = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(16))));
  const csp = `default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'; connect-src 'self'; form-action 'none'; base-uri 'none'; frame-ancestors 'none'`;
  return page("botline owner view", `${STYLE}${BODY}<script nonce="${nonce}">${SCRIPT}</script>`, 200, csp);
}

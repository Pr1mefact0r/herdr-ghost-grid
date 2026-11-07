// Daemons: every agent is a little terminal bot on a grid, acting out its status.
// Hover a daemon for its context usage; hc messages between agents show as packets.
//
// Data (Claude Code agents only), refreshed every REFRESH_MS:
//   hc get <addr>                       -> foreground pid
//   ~/.claude/sessions/<pid>.json       -> sessionId + cwd
//   ~/.claude/projects/<cwd-slug>/<sessionId>.jsonl (tail) -> last usage, received <hc from="..."> messages
import { View, div } from "gpui-kit";
import { v_flex, h_flex, HoverCard } from "gpui-base";
import { agents, spaces, machines, run, theme, setAgentOrder, hc, exec, settings, nextCommand } from "herdr";

const SPRITE_W = 120;
const REFRESH_MS = 1500;       // cheap change check; files are re-read only when they changed
const REMOTE_EVERY = 2;         // remote transcripts: every 2nd check
const RESOLVE_MS = 20000;       // look up which session an agent runs this often
const TAIL_LINES = 600;          // last transcript lines read per agent
const TAIL_LINES_REMOTE = 300;   // fewer over ssh
const MAX_LINE = 20000;          // longer lines (images, big tool output) are cut and skipped
const CONTEXT_WINDOW = 1000000;   // assumed context window of the current Claude models; adjust if needed
const LIVE_MS = 90 * 1000;        // a message counts as "in flight" this long
const RECENT_MS = 30 * 60 * 1000; // ticker shows messages this recent

const LOOK = {
  working: { face: ["[>_ ]", "[>_▮]"], ms: 420, note: ["01", "10", "11", "00", "01"], noteMs: 140, word: "läuft" },
  blocked: { face: ["[!_!]", "[!_!]", "[°□°]"], ms: 260, note: ["⚠", " "], noteMs: 400, word: "braucht dich" },
  done:    { face: ["[-_-]"], ms: 1000, note: ["z", "zz", "zzz", " "], noteMs: 450, word: "fertig" },
  idle:    { face: ["[·_·]", "[·_·]", "[·_·]", "[-_-]"], ms: 900, note: ["▮", " "], noteMs: 530, word: "wartet" },
};
const VISIT_MS = 3 * 60 * 1000;   // a caller waits at most this long beside the one it asked
const HOP_MS = 480;             // one hop of the thank-you
const HOPS = 3;
const WALK_MS = 2200;
const ANSWER_MS = 6 * 1000;    // the answer stays readable this long, then both say thanks
const AFTER_REPLY_MS = ANSWER_MS + HOP_MS * HOPS;   // three hops in step, retro-RPG style, then the caller walks home
const LOVE = { face: ["[♥_♥]", "[♥‿♥]"], ms: 500 };   // the thank-you: heart eyes and a little hop
const PACKET = ["⇢    ", "·⇢   ", "··⇢  ", "···⇢ ", "····⇢"];

// A message's phases run from when this screen first saw it: a sender's log stamps it when the
// agent starts writing, and we may only read it seconds later.
function start(m) { return Math.max(m.at || 0, m.seen || 0); }
function hash(s) { let h = 7; for (const c of s) h = (h * 31 + c.charCodeAt(0)) >>> 0; return h; }
function kTok(n) { return n >= 1e6 ? (n / 1e6).toFixed(2) + "M" : n >= 1000 ? Math.round(n / 1000) + "k" : String(n); }
function ago(ts) {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  return s < 60 ? `vor ${s}s` : s < 3600 ? `vor ${Math.round(s / 60)} min` : `vor ${Math.round(s / 3600)} h`;
}
function clock(ts) { const d = new Date(ts); return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`; }
function textOf(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((x) => (x && x.type === "text" ? x.text : "")).join(" ");
}

export default class Daemons extends View {
  init(_props, cx) {
    this.info = {};      // address -> { model, ctx, out, at, session }
    this.msgs = [];      // { from, to, at, text }
    this.demo = [];      // made-up messages from the "demo" command; never sent to anyone
    this.host = null;    // this computer's name, to recognise "<host>/t1" as one of ours
    this.self = new Set(); // every name another machine may use for this one: hostname, host.local, its IPs
    this.alias = new Map(); // hostname of a connected machine -> its name here ("desk" -> "10.0.0.5")
    this.seen = new Map();  // message key -> when this screen first saw it
    cx.spawn(async () => {
      try {
        this.host = (await exec("hostname", [])).stdout.trim();
        const ips = (await exec("hostname", ["-I"])).stdout.trim().split(/\s+/).filter(Boolean);
        this.self = new Set([this.host, `${this.host}.local`, "localhost", "127.0.0.1", ...ips].map((x) => x.toLowerCase()));
      } catch {}
    });
    cx.timer.every(REFRESH_MS, (cx) => this.refresh(cx));
    // Bound to the agents' own actions: a message arriving or going out changes an agent's status/seq,
    // which Herdr pushes at once (across machines too). Read right then instead of waiting for the next check.
    // Cheap: compares a string, no redraw.
    cx.timer.every(250, (cx) => {
      const sig = agents().map((a) => `${a.address}:${a.status}:${a.seq}`).join("|");
      if (sig !== this.lastSig) { this.lastSig = sig; this.refresh(cx); }
    });
    this.refresh(cx);
    cx.spawn(async (cx) => {
      for (;;) {
        const c = await nextCommand();
        if (c === "demo" || c?.name === "demo") { this.startDemo(cx); cx.notify(); }
        if (c === "demo-guest" || c?.name === "demo-guest") { this.startDemo(cx, true); cx.notify(); }
      }
    });
  }

  // Redraws exactly when a visit changes phase, so the three hops end on time.
  scheduleBoundaries(cx) {
    this.scheduled = this.scheduled || new Set();
    const now = Date.now();
    const all = [...(this.real || []), ...this.demo];
    for (const m of all) {
      if (!m.at) continue;
      const s0 = start(m);
      for (const at of [s0, s0 + ANSWER_MS, s0 + AFTER_REPLY_MS, s0 + AFTER_REPLY_MS + WALK_MS, s0 + VISIT_MS]) {
        const d = at - now;
        if (d <= 0 || d > REFRESH_MS * 3 || this.scheduled.has(at)) continue;
        this.scheduled.add(at);
        cx.timer.after(d + 30, (cx) => { this.scheduled.delete(at); cx.notify(); });
      }
    }
  }

  // Plays a short conversation between the first two agents, only on this screen.
  startDemo(cx, guest = false) {
    const list = agents();
    if (list.length < (guest ? 1 : 2)) return;
    const a = guest ? "laptop/t1" : list[0].address, b = list[list.length - 1].address, now = Date.now();
    this.demo = [
      { from: a, to: b, at: now, text: "Demo: kannst du kurz die Tests laufen lassen?" },
      { from: b, to: a, at: now + 9000, text: "Klar, alle 42 sind grün." },
    ];
    this.scheduleBoundaries(cx);
  }

  // Reads one agent's transcript tail: usage, received <hc from> messages, and its own `hc send`s.
  parseTail(a, machine, tail, name) {
    const msgs = [], sent = [], pending = {};
    const it = { session: name, model: null, ctx: null, out: 0, at: null };
    for (const line of tail.split("\n")) {
      if (!line.startsWith("{")) continue;
      let d; try { d = JSON.parse(line); } catch { continue; }
      const ts = d.timestamp ? Date.parse(d.timestamp) : null;
      const m = d.message;
      if (d.type === "assistant" && Array.isArray(m?.content)) {
        for (const c of m.content) {
          const cmd = c?.type === "tool_use" && c.name === "Bash" ? String(c.input?.command || "") : "";
          const sentHere = [];
          for (const hit of cmd.matchAll(/\bhc\s+send\s+(?:--?\S+\s+)*([A-Za-z0-9._-]+(?:\/t\d+)?|t\d+)\s+(?:"([^"]{0,120})|'([^']{0,120})|(\S[^\n]{0,119}))/g))
            sentHere.push({ from: a.address, to: this.addr(hit[1], machine), at: ts, text: (hit[2] ?? hit[3] ?? hit[4] ?? "").replace(/\$\([^)]*\)/g, "…").replace(/\s+/g, " ").trim() });   // $(…) is only known once delivered
          // counted from the moment it was sent (an answer may arrive before the command finishes);
          // dropped again only if its result reports an error
          if (sentHere.length) { pending[c.id] = sentHere; sent.push(...sentHere); }
        }
      }
      if (d.type === "assistant" && m?.usage) {
        const u = m.usage;
        it.ctx = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
        it.out += u.output_tokens || 0;
        it.model = m.model || it.model;
        it.at = ts;
      } else if (d.type === "user" && m) {
        if (Array.isArray(m.content)) for (const c of m.content) {
          if (c?.type !== "tool_result" || !pending[c.tool_use_id]) continue;
          const out = typeof c.content === "string" ? c.content : textOf(c.content);
          if (c.is_error || /"error"\s*:/.test(out))
            for (const x of pending[c.tool_use_id]) { const k = sent.indexOf(x); if (k >= 0) sent.splice(k, 1); }
          delete pending[c.tool_use_id];
        }
        const txt = textOf(m.content);
        for (const hit of txt.matchAll(/<hc from="([^"\s]+)[^"]*"[^>]*>([^<]{0,120})/g))
          msgs.push({ from: this.addr(hit[1], machine), to: a.address, at: ts, text: hit[2].replace(/\s+/g, " ").trim() });
      }
    }
    return { it, msgs, sent };
  }

  // Every REFRESH_MS: a cheap size/mtime check per transcript; a file is only read again when it changed.
  // Which session belongs to an agent is looked up again every RESOLVE_MS (or when its process changes).
  refresh(cx) {
    if (this.busy) return;
    this.busy = true;
    this.tick = (this.tick || 0) + 1;
    this.cache = this.cache || {};
    cx.spawn(async (cx) => {
      let changed = !this.firstRefreshDone;
      const errs = {};
      if (this.tick % 20 === 1) try {
        const ls = JSON.parse((await hc(["machine", "ls", "--json"])).stdout);
        this.alias = new Map((ls.machines || []).filter((m) => m.host && m.name).map((m) => [m.host.toLowerCase(), m.name]));
      } catch {}
      const list = agents().filter((a) => a.app === "claude-code");
      for (const a of list) {
        const machine = spaces().find((x) => x.id === a.space)?.machine
          ?? (a.address.includes("/") ? a.address.split("/")[0] : null);
        if (machine && this.tick % REMOTE_EVERY !== 1 && this.cache[a.address]) continue;   // remote: less often
        const sh = async (cmd) => {
          const r = await exec("sh", ["-c", cmd], { on: machine });
          if (r.code !== 0 && r.code != null) throw new Error((r.stderr || "").trim().split("\n").pop() || `exit ${r.code}`);
          return r.stdout;
        };
        try {
          let c = this.cache[a.address];
          if (!c || Date.now() - c.resolved > RESOLVE_MS) {
            const g = JSON.parse((await hc(["get", a.address, "--json"])).stdout);
            const pid = g?.foreground?.pid;
            if (!pid) { errs[a.address] = "kein laufender prozess"; delete this.cache[a.address]; continue; }
            if (!c || c.pid !== pid) {
              const sess = JSON.parse(await sh(`cat "$HOME/.claude/sessions/${Number(pid)}.json"`));
              const slug = String(sess.cwd).replace(/[^A-Za-z0-9]/g, "-");
              const sid = String(sess.sessionId).replace(/[^A-Za-z0-9-]/g, "");
              c = { pid, name: sess.name, file: `.claude/projects/${slug}/${sid}.jsonl`, sig: null, data: null };
            }
            c.resolved = Date.now();
            this.cache[a.address] = c;
          }
          const lines = machine ? TAIL_LINES_REMOTE : TAIL_LINES;
          const out = await sh(`f="$HOME/${c.file}"; s=$(stat -c '%s.%Y' "$f") || exit 1; ` +
            `if [ "$s" = "${c.sig || ""}" ]; then echo "=SAME"; else echo "=$s"; tail -n ${lines} "$f" | cut -c1-${MAX_LINE}; fi`);
          const nl = out.indexOf("\n");
          const head = (nl < 0 ? out : out.slice(0, nl)).trim();
          if (head !== "=SAME") {
            c.sig = head.slice(1);
            c.data = this.parseTail(a, machine, nl < 0 ? "" : out.slice(nl + 1), c.name);
            changed = true;
          }
        } catch (e) { errs[a.address] = String(e?.message || e).slice(0, 80); }
      }
      // forget agents that are gone
      for (const k of Object.keys(this.cache)) if (!list.some((a) => a.address === k)) { delete this.cache[k]; changed = true; }
      if (JSON.stringify(errs) !== JSON.stringify(this.errs || {})) changed = true;
      if (!changed) { this.busy = false; this.scheduleBoundaries(cx); return; }   // nothing new: no redraw

      const info = {}, msgs = [], sent = [];
      for (const [k, c] of Object.entries(this.cache)) {
        if (!c.data) continue;
        info[k] = c.data.it; msgs.push(...c.data.msgs); sent.push(...c.data.sent);
      }
      for (const m of sent)
        if (!msgs.some((x) => x.from === m.from && x.to === m.to && Math.abs((x.at || 0) - (m.at || 0)) < 60000)) msgs.push(m);
      msgs.sort((x, y) => (x.at || 0) - (y.at || 0));
      const nowSeen = Date.now();
      for (const m of msgs) {
        const k = `${m.from}|${m.to}|${m.text.slice(0, 40)}`;
        if (!this.seen.has(k)) this.seen.set(k, this.firstRefreshDone ? nowSeen : 0);   // old history isn't replayed
        m.seen = this.seen.get(k);
      }
      this.firstRefreshDone = true;
      this.info = info;
      this.errs = errs;
      this.real = msgs;
      this.msgs = msgs;
      this.busy = false;
      this.scheduleBoundaries(cx);
      cx.notify();
    });
  }

  // An address as written on machine `from` (null = here), turned into how this screen names it:
  // "t3" read on vps -> "vps/t3"; "<this host>/t3" -> "t3"; "laptop/t3" stays (a guest if we don't know it).
  addr(raw, from) {
    // machine names compare case-insensitively (hostname "LAPTOP-01" may arrive as "laptop-01")
    const lc = (x) => String(x || "").toLowerCase();
    const known = new Map(machines().filter((m) => m.name).map((m) => [lc(m.name), m.name]));
    if (!raw.includes("/")) return from ? `${from}/${raw}` : raw;
    const [mach, id] = raw.split("/");
    if (lc(mach) === lc(this.host) || this.self.has(lc(mach))) return id;
    if (known.has(lc(mach))) return `${known.get(lc(mach))}/${id}`;
    if (this.alias.has(lc(mach))) return `${this.alias.get(lc(mach))}/${id}`;
    return `${lc(mach)}/${id}`;
  }

  color(t, status) {
    return { working: t.working, blocked: t.blocked, done: t.done, idle: t.idle }[status] ?? t.unknown;
  }

  // The caller's latest message, the answer to it if any, and whether it is still standing there.
  // Pairs every message in time order: a message answers the other side's open question
  // (one sent to it, still unanswered, less than VISIT_MS old); otherwise it is a new question.
  pairUp(msgs) {
    const open = new Map();   // "from>to" -> latest unanswered question
    for (const m of msgs) {
      m.reply = null; m.isReply = false;
      const q = open.get(`${m.to}>${m.from}`);
      if (q && m.at - q.at < VISIT_MS) {
        m.isReply = true; q.reply = m;
        open.delete(`${m.to}>${m.from}`);
      } else {
        open.set(`${m.from}>${m.to}`, m);
      }
    }
  }

  // The caller's latest question, its answer if any, and whether it is still standing there.
  visitOf(addr, now) {
    const m = this.msgs.filter((x) => x.from === addr && x.at && !x.isReply).pop();
    if (!m) return null;
    const reply = m.reply;
    const until = reply ? start(reply) + AFTER_REPLY_MS : start(m) + VISIT_MS;
    return { m, reply, active: now < until, until };
  }

  // Someone is standing beside this agent right now: the visit, with its answer if given.
  answering(addr, now) {
    const senders = new Set(this.msgs.filter((m) => m.to === addr).map((m) => m.from));
    for (const from of senders) {
      if (from === addr) continue;
      const v = this.visitOf(from, now);
      if (v?.active && v.m.to === addr) return v;
    }
    return null;
  }

  // Someone with no daemon on this screen (another machine) visiting this agent: drawn as a ghost beside it.
  guestFor(addr, now) {
    const shown = new Set(agents().map((a) => a.address));
    const v = this.answering(addr, now);
    return v && !shown.has(v.m.from) ? v : null;
  }

  ghost(t, v, now, side) {
    const love = v.reply && now - start(v.reply) >= ANSWER_MS;
    const [mach, id] = v.m.from.includes("/") ? v.m.from.split("/") : ["?", v.m.from];
    let g = v_flex().absolute().bottom(0).left(side > 0 ? SPRITE_W + 6 : -SPRITE_W - 6).w(SPRITE_W).items_center().gap(2)
      .loop("opacity", { from: 0.6, to: 0.95, period: 2400 });
    // no hop of its own: it sits inside the host's column, which hops for both
    return g
      .child(v.reply ? div().h(16) : this.bubbleSay(t, v.m.text, t.muted))
      .child(div().px(8).py(2).rounded(6).border_1().border_color(love ? "#ff7ab6" : t.muted).bg("#050d0a80")
        .text_size(18).font_family("Hack").font_weight(700).text_color(love ? "#ff7ab6" : t.muted).whitespace_nowrap()
        .frames(love ? LOVE.face : ["[◇_◇]", "[◇_◇]", "[◆_◆]"], love ? LOVE.ms : 700))
      .child(div().h(2))
      .child(v_flex().items_center()
        .child(div().text_size(11).text_color(t.muted).truncate().max_w(SPRITE_W).child(mach))
        .child(div().text_size(10).text_color(t.dim).child(`${id} · gast`)));
  }

  // Floats above the daemon without widening its column (a wider column would shift every slot).
  bubbleSay(t, text, col) {
    return div().relative().w(SPRITE_W).h(16).child(this.bubbleCard(t, text, col).absolute().bottom(0).left((SPRITE_W - 210) / 2));
  }

  bubbleCard(t, text, col) {
    return v_flex().w(210).items_center()
      .child(div().max_w(210).px(8).py(4).rounded(8).border_1().border_color(col).bg(t.popover)
        .text_size(11).text_color(t.foreground).child(`„${text.slice(0, 64)}${text.length > 64 ? "…" : ""}“`))
      .child(div().text_size(10).text_color(col).child("▼"));
  }

  nameOf(addr) {
    const a = agents().find((x) => x.address === addr);
    return a ? a.space_name : addr;
  }

  card(t, a) {
    const it = this.info[a.address];
    const c = this.color(t, a.status);
    const row = (k, v, col) => h_flex().justify_between().gap(16)
      .child(div().text_color(t.dim).child(k)).child(div().text_color(col ?? t.foreground).child(v));
    let body = v_flex().w(260).p(12).gap(6).rounded(8).border_1().border_color(c).bg(t.popover)
      .text_size(12).font_family("Hack").text_color(t.foreground)
      .child(h_flex().justify_between()
        .child(div().text_color(c).font_weight(700).child(a.space_name))
        .child(div().text_color(t.dim).child(a.address)))
      .child(div().text_color(t.muted).truncate().child(`${a.tab_name} · ${(LOOK[a.status] ?? LOOK.idle).word}`));

    if (!it || it.ctx == null) {
      const err = this.errs?.[a.address];
      const why = a.app !== "claude-code" ? "keine Kontextdaten für dieses Programm"
        : err ? `nicht lesbar: ${err}` : "lese session…";
      return body.child(div().text_color(err ? t.blocked : t.dim).child(why));
    }
    const pct = Math.min(1, it.ctx / CONTEXT_WINDOW);
    const barCol = pct > 0.8 ? t.blocked : pct > 0.5 ? t.done : t.accent;
    const sent = this.msgs.filter((m) => m.from === a.address);
    const got = this.msgs.filter((m) => m.to === a.address);
    const last = [...sent, ...got].sort((x, y) => (y.at || 0) - (x.at || 0))[0];

    body = body
      .child(div().h(1).bg(t.border))
      .child(row("kontext", `${kTok(it.ctx)} / ${kTok(CONTEXT_WINDOW)}`, barCol))
      .child(div().h(6).w(236).rounded(3).bg(t.raised)
        .child(div().h(6).rounded(3).bg(barCol).w(Math.max(3, Math.round(236 * pct)))))
      .child(row("auslastung", `${Math.round(pct * 100)}%`, barCol))
      .child(row("output (log)", kTok(it.out)))
      .child(row("modell", (it.model || "?").replace(/^claude-/, "")))
      .child(row("letzte antwort", it.at ? ago(it.at) : "–"))
      .child(row("session", it.session || "–", t.muted))
      .child(div().h(1).bg(t.border))
      .child(row("hc gesendet", String(sent.length)))
      .child(row("hc empfangen", String(got.length)));
    if (last) {
      const dir = last.from === a.address ? `⇢ ${this.nameOf(last.to)}` : `⇠ ${this.nameOf(last.from)}`;
      body = body
        .child(div().text_color(t.muted).text_size(11).child(`${dir} · ${clock(last.at)}`))
        .child(div().text_color(t.dim).text_size(11).child(`„${last.text.slice(0, 70)}…“`));
    }
    return body;
  }

  daemon(t, a, now, i, list) {
    const look = LOOK[a.status] ?? LOOK.idle;
    const c = this.color(t, a.status);
    const h = hash(a.address);
    const roam = 40 + (h % 30);

    let el = v_flex().id(`d-${a.address}`).relative().w(SPRITE_W).items_center().gap(2).top(0)
      .cursor_pointer().on_click(() => run("agent.focus", { terminal: a.address }));
    // Walking over to the one it asked, and back home afterwards.
    const visit = this.visitOf(a.address, now);
    const target = visit?.active ? list.findIndex((x) => x.address === visit.m.to) : -1;
    if (target >= 0 && target !== i) {
      const zoom = Number(settings().zoom) || 1;
      const slot = ((this.width || 1200) / zoom - 40) / list.length;
      const dx = (target - i) * slot - Math.sign(target - i) * (SPRITE_W + 10);
      el = el.transition("left", { duration: WALK_MS, easing: "ease-in-out" }).left(dx);
    } else {
      el = el.transition("left", { duration: WALK_MS, easing: "ease-in-out" }).left(0);
      const home = visit && now - visit.until < WALK_MS + REFRESH_MS;
      // someone on the way or standing beside it: hold still at home so the visitor never walks into it
      const hosting = this.answering(a.address, now);
      if (a.status === "working" && !home && !hosting)
        el = el.loop("left", { from: -roam, to: roam, period: 5200 + (h % 2600), easing: "ease-in-out" });
    }
    if (a.status === "blocked")
      el = el.loop("top", { from: -12, to: 0, period: 520, easing: "ease-out" });
    if (a.status === "idle")
      el = el.loop("opacity", { from: 0.45, to: 0.85, period: 3200 + (h % 1200) });

    const out = this.msgs.filter((m) => m.from === a.address && now - m.at < LIVE_MS).pop();
    const inn = this.msgs.filter((m) => m.to === a.address && now - m.at < LIVE_MS).pop();

    let bubble;
    if (a.status === "blocked") {
      bubble = div().px(6).rounded(4).bg(t.blocked).text_color(t.accent_foreground).text_size(11).font_weight(700)
        .child(`! ${a.app ?? "agent"}`).loop("opacity", { from: 0.55, to: 1, period: 700 });
    } else if (target >= 0 && target !== i) {
      bubble = visit.reply ? div().h(16) : this.bubbleSay(t, visit.m.text, t.accent);   // waits quietly while the answer shows
    } else if (this.answering(a.address, now)) {
      const r = this.answering(a.address, now);
      bubble = r.reply ? (now - start(r.reply) < ANSWER_MS ? this.bubbleSay(t, r.reply.text, t.done) : div().h(16))
        : div().px(6).rounded(4).border_1().border_color(t.accent).text_color(t.accent).text_size(11).font_family("Hack")
            .child(`⇠ ${this.nameOf(r.m.from)}`).loop("opacity", { from: 0.5, to: 1, period: 600 });
    } else if (out || inn) {
      const m = out || inn;
      const label = out ? `⇢ ${this.nameOf(m.to)}` : `⇠ ${this.nameOf(m.from)}`;
      bubble = div().px(6).rounded(4).border_1().border_color(t.accent).bg("#7ddcb422").text_color(t.accent)
        .text_size(11).font_family("Hack").child(label).loop("opacity", { from: 0.5, to: 1, period: 600 });
    } else {
      bubble = div().h(16).text_size(11).text_color(c).opacity(0.8).frames(look.note, look.noteMs);
    }

    const it = this.info[a.address];
    const pct = it?.ctx != null ? Math.min(1, it.ctx / CONTEXT_WINDOW) : null;
    const answered = this.answering(a.address, now);
    const thanks = (v) => v && v.reply && now - start(v.reply) >= ANSWER_MS;
    const love = (visit?.active && thanks(visit)) || (answered && thanks(answered));
    // both hop together, three times, then it's over
    if (love) el = el.loop("top", { from: 0, to: -12, period: HOP_MS, easing: "ease-out" });
    const body = div().px(8).py(2).rounded(6).border_1().border_color(love ? "#ff7ab6" : c)
      .bg(a.focused ? t.selected : "#050d0ab0")
      .text_size(18).font_family("Hack").font_weight(700).text_color(love ? "#ff7ab6" : c).whitespace_nowrap()
      .frames(love ? LOVE.face : look.face, love ? LOVE.ms : look.ms);
    const meter = div().h(2).w(64).rounded(1).bg(t.raised)
      .child(div().h(2).rounded(1).bg(pct == null ? t.raised : pct > 0.8 ? t.blocked : pct > 0.5 ? t.done : t.accent)
        .w(pct == null ? 0 : Math.max(2, Math.round(64 * pct))));

    const label = v_flex().items_center()
      .child(div().text_size(11).text_color(t.foreground).truncate().max_w(SPRITE_W).child(a.space_name))
      .child(div().text_size(10).text_color(t.dim).truncate().max_w(SPRITE_W).child(`${a.tab_name} · ${look.word}`));

    el = el.child(bubble).child(body).child(meter).child(label);
    const guest = this.guestFor(a.address, now);
    if (guest) el = el.child(this.ghost(t, guest, now, i === list.length - 1 ? -1 : 1));
    return HoverCard.new(`hc-${a.address}`).open_delay(250).close_delay(150).anchor("top_center")
      .trigger(el).content(this.card(t, a));
  }

  ticker(t, now) {
    const recent = this.msgs.filter((m) => m.at && now - m.at < RECENT_MS).slice(-3).reverse();
    if (recent.length === 0)
      return h_flex().flex_none().h(18).px(14).text_size(11).font_family("Hack").text_color(t.dim)
        .child("· kein hc-verkehr in den letzten 30 min");
    return h_flex().flex_none().h(18).px(14).gap(18).text_size(11).font_family("Hack").overflow_hidden()
      .children(recent.map((m, i) => {
        const live = now - m.at < LIVE_MS;
        return h_flex().id(`tk-${i}`).gap(6).flex_none().text_color(live ? t.accent : t.dim)
          .child(div().child(this.nameOf(m.from)))
          .child(live ? div().w(36).frames(PACKET, 160) : div().child("⇢"))
          .child(div().child(this.nameOf(m.to)))
          .child(div().text_color(t.dim).child(`${clock(m.at)} „${m.text.slice(0, 34)}…“`));
      }));
  }

  render() {
    const t = theme();
    const list = agents();
    const now = Date.now();
    const demo = this.demo.filter((m) => m.at <= now);
    this.msgs = [...(this.real || []), ...demo].map((m) => ({ ...m })).sort((x, y) => x.at - y.at);
    this.pairUp(this.msgs);

    setAgentOrder(list.map((a) => a.address));
    const count = (s) => list.filter((a) => a.status === s).length;

    const header = h_flex().flex_none().h(24).px(14).justify_between().items_center()
      .text_size(11).font_family("Hack").text_color(t.dim)
      .child(h_flex().gap(8)
        .child(div().text_color(t.accent).frames(["▌", " "], 600))
        .child(div().text_color(t.muted).child(`THE GRID · ${list.length} daemon${list.length === 1 ? "" : "s"}`)))
      .child(h_flex().gap(14)
        .child(div().text_color(t.working).child(`▸ ${count("working")} läuft`))
        .child(div().text_color(t.blocked).child(`! ${count("blocked")} braucht dich`))
        .child(div().text_color(t.done).child(`✓ ${count("done")} fertig`))
        .child(div().text_color(t.idle).child(`· ${count("idle")} wartet`)));

    const field = list.length === 0
      ? h_flex().flex_1().justify_center().items_center().text_size(12).font_family("Hack").text_color(t.dim)
          .frames(["keine daemons online — starte einen agent ▮", "keine daemons online — starte einen agent  "], 600)
      : h_flex().flex_1().min_h(0).justify_around().items_end().pb(8).px(20)
          .children(list.map((a, i) => this.daemon(t, a, now, i, list)));

    return v_flex().id("root").size_full().overflow_hidden().bg("#040a08b8")
      .border_b(1).border_color("#7ddcb466")
      .on_size_change((size, cx) => { if (size.width !== this.width) { this.width = size.width; cx.notify(); } })
      .child(header)
      .child(this.ticker(t, now))
      .child(field);
  }
}

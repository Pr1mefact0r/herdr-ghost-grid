// Daemons: every agent is a little terminal bot on a grid, acting out its status.
// Hover a daemon for its context usage; hc messages between agents show as packets.
//
// Data (Claude Code agents only), refreshed every REFRESH_MS:
//   hc get <addr>                       -> foreground pid
//   ~/.claude/sessions/<pid>.json       -> sessionId + cwd
//   ~/.claude/projects/<cwd-slug>/<sessionId>.jsonl (tail) -> last usage, received <hc from="..."> messages
import { View, div } from "gpui-kit";
import { v_flex, h_flex, HoverCard } from "gpui-base";
import { newStage, plan, view, CFG } from "./stage.js";
import { agents, spaces, machines, run, theme, setAgentOrder, hc, exec, settings, nextCommand } from "herdr";

const SPRITE_W = 120;
const MIN_SLOT = 130;           // below this per daemon, daemons gather by status (idle, working, done, blocked), then shrink
const REFRESH_MS = 1500;       // cheap change check; files are re-read only when they changed
const REMOTE_EVERY = 2;         // remote transcripts: every 2nd check
const RESOLVE_MS = 20000;       // look up which session an agent runs this often
const TAIL_LINES = 600;          // last transcript lines read per agent
const TAIL_LINES_REMOTE = 300;   // fewer over ssh
const MAX_LINE = 20000;          // longer lines (images, big tool output) are cut and skipped
const CONTEXT_WINDOW = 1000000;   // assumed context window of the current Claude models; adjust if needed
const LIVE_MS = 90 * 1000;        // a message counts as "in flight" this long
const RECENT_MS = 30 * 60 * 1000; // ticker shows messages this recent

// UI language: "en" or "de"
const LANG = "en";
const TEXT = {
  en: { working: "working", blocked: "needs you", done: "done", idle: "idle", ago: (n, u) => `${n}${u} ago`,
        demoQ: "Demo: could you run the tests real quick?", demoA: "Sure, all 42 are green.",
        noProc: "no running process", guest: "guest", noData: "no context data for this program",
        unreadable: "can't read", reading: "reading session…", context: "context", usage: "usage",
        model: "model", lastAnswer: "last answer", sent: "hc sent", received: "hc received",
        quiet: "· no hc traffic in the last 30 min", empty: "no daemons online — start an agent", q: ["“", "”"],
        needYou: "need you", thanks: "✓ thanks", aye: "aye aye, captain!", meeting: "meeting", tasks: (n) => `${n} tasks` },
  de: { working: "läuft", blocked: "braucht dich", done: "fertig", idle: "wartet", ago: (n, u) => `vor ${n}${u === "s" ? "s" : " " + u}`,
        demoQ: "Demo: kannst du kurz die Tests laufen lassen?", demoA: "Klar, alle 42 sind grün.",
        noProc: "kein laufender prozess", guest: "gast", noData: "keine Kontextdaten für dieses Programm",
        unreadable: "nicht lesbar", reading: "lese session…", context: "kontext", usage: "auslastung",
        model: "modell", lastAnswer: "letzte antwort", sent: "hc gesendet", received: "hc empfangen",
        quiet: "· kein hc-verkehr in den letzten 30 min", empty: "keine daemons online — starte einen agent", q: ["„", "“"],
        needYou: "brauchen dich", thanks: "✓ danke", aye: "aye aye, Käpt'n!", meeting: "besprechung", tasks: (n) => `${n} Aufträge` },
};
const T = TEXT[LANG] || TEXT.en;

const LOOK = {
  working: { face: ["[>_ ]", "[>_▮]"], ms: 420, note: ["01", "10", "11", "00", "01"], noteMs: 140, word: T.working },
  blocked: { face: ["[!_!]", "[!_!]", "[°□°]"], ms: 260, note: ["⚠", " "], noteMs: 400, word: T.blocked },
  done:    { face: ["[-_-]"], ms: 1000, note: ["z", "zz", "zzz", " "], noteMs: 450, word: T.done },
  idle:    { face: ["[·_·]", "[·_·]", "[·_·]", "[-_-]"], ms: 900, note: ["▮", " "], noteMs: 530, word: T.idle },
};
const VISIT_MS = 60 * 1000;      // a caller waits at most this long beside the one it asked
const GIVE_UP_MS = 8 * 1000;
const WORK_GIVE_UP_MS = 10 * 1000; // …or once it has arrived and the one asked is busy working on it
const MEET_WINDOW_MS = 15 * 1000; // one sender to 2+ others within this window = a meeting
const MEET_HOLD_MS = 6 * 1000;    // the meeting lasts this long after the last one arrived     // …or this long once the one asked is idle/done again without answering
const HOP_MS = 480;             // one hop of the thank-you
const HOPS = 3;
const WALK_MS = 2800;
const SHIFT_MS = 1000;           // others sliding aside to make room
const DEPART_MS = SHIFT_MS + 1500; // a caller sets off this long after sending (a 2nd task meanwhile = meeting)
const STACK_H = 24;
const TAG_OFF_MS = 450;          // a traveller's tag goes this long before it comes down              // height of one small daemon in a meeting stack
const RISE_MS = 550;             // a gathered daemon first rises out of its group, in place
const LANE_UP = 62;              // the upper track: all changes of place run up here, over the others' heads
const SPEED = 0.52;              // px per ms on the track (unzoomed): same speed for all, so nobody overtakes
const RISE_UP_MS = 300;          // up onto the track / down off it
const PKT_R = 110;               // around a switch (or a crossing) daemons travel as data packets, this far
const MORPH_MS = 220;            // the glitchy change between daemon and packet
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
  return s < 60 ? T.ago(s, "s") : s < 3600 ? T.ago(Math.round(s / 60), "min") : T.ago(Math.round(s / 3600), "h");
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
      if (this.kick) { this.kick = false; cx.notify(); }   // new elements start moving from where they came
    });
    // the script's own clock: redraw exactly when a planned phase starts (rise, go, morph, packet, land)
    cx.timer.every(80, (cx) => {
      const now = Date.now();
      if (this.stage?.marks.some((m) => m > (this.lastMark ?? 0) && m <= now)) { this.lastMark = now; cx.notify(); }
    });
    this.refresh(cx);
    cx.spawn(async (cx) => {
      for (;;) {
        const c = await nextCommand();
        if (c === "demo" || c?.name === "demo") { this.startDemo(cx); cx.notify(); }
        if (c === "demo-guest" || c?.name === "demo-guest") { this.startDemo(cx, true); cx.notify(); }
        if (c === "demo-multi" || c?.name === "demo-multi") { this.startDemoMulti(cx); cx.notify(); }
        if (c === "demo-meeting" || c?.name === "demo-meeting") { this.startDemoMeeting(cx); cx.notify(); }
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
      for (const at of [s0, s0 + DEPART_MS + 20, s0 + DEPART_MS + RISE_MS + 20, s0 + DEPART_MS + WALK_MS + 20, s0 + DEPART_MS + RISE_MS + WALK_MS + 20, s0 + DEPART_MS + WALK_MS + 20, s0 + AFTER_REPLY_MS + WALK_MS + 40, s0 + ANSWER_MS, s0 + AFTER_REPLY_MS, s0 + AFTER_REPLY_MS + WALK_MS, s0 + VISIT_MS]) {
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
      { from: a, to: b, at: now, text: T.demoQ },
      { from: b, to: a, at: now + 9000, text: T.demoA },
    ];
    this.scheduleBoundaries(cx);
  }

  // Several overlapping conversations (stress test), only on this screen: two callers to the same one,
  // and pairs starting while others are still walking. Needs 6+ agents.
  startDemoMulti(cx) {
    const L = agents().map((a) => a.address);
    if (L.length < 6) return;
    const last = L[L.length - 1], now = Date.now();
    const q = (from, to, dt, rt, n) => [
      { from, to, at: now + dt, text: `${T.demoQ} (${n})` },
      { from: to, to: from, at: now + rt, text: `${T.demoA} (${n})` },
    ];
    this.demo = [
      ...q(L[0], last, 0, 9000, 1),
      ...q(L[1], L[2], 1500, 11000, 2),
      ...q(L[3], last, 3000, 13000, 3),
      ...q(L[4], L[5], 5000, 15000, 4),
    ];
    for (const m of this.demo) for (const d of [0, DEPART_MS + 20, DEPART_MS + RISE_MS + 20, DEPART_MS + RISE_MS + WALK_MS + 20, ANSWER_MS + 20, AFTER_REPLY_MS + 20, AFTER_REPLY_MS + WALK_MS + 40])
      cx.timer.after(m.at - now + d, (cx) => cx.notify());
  }

  // A meeting: the first daemon hands out tasks to three others; later two of them report back.
  startDemoMeeting(cx) {
    const L = agents().map((a) => a.address);
    if (L.length < 4) return;
    const h = L[0], now = Date.now(), task = T.demoQ;
    this.demo = [
      { from: h, to: L[L.length - 1], at: now, text: task },
      { from: h, to: L[2], at: now + 1200, text: task },
      { from: h, to: L[L.length - 2], at: now + 2400, text: task },
      // reports come back once the meeting is over and everybody is home again (as real ones would)
      { from: L[2], to: h, at: now + 30000, text: T.demoA },
      { from: L[L.length - 1], to: h, at: now + 32500, text: T.demoA },
    ];
    for (let d = 0; d < 62000; d += 500) cx.timer.after(d, (cx) => cx.notify());
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
          // heredoc bodies (<<EOF … EOF) are file contents, not commands: drop them before looking for `hc send`
          const cmd = (c?.type === "tool_use" && c.name === "Bash" ? String(c.input?.command || "") : "")
            .replace(/<<-?\s*['"]?(\w+)['"]?[^\n]*\n[\s\S]*?\n\s*\1\s*(?=\n|$)/g, "\n");
          const sentHere = [];   // only real commands: `hc send` at a line start or after ; & | ( then do — not inside text
          for (const hit of cmd.matchAll(/(?:^|[;&|(]|\bthen\b|\bdo\b)[ \t]*hc\s+send\s+(?:--?\S+\s+)*([A-Za-z0-9._-]+(?:\/t\d+)?|t\d+)\s+(?:"([^"]{0,120})|'([^']{0,120})|(\S[^\n]{0,119}))/gm))
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
            if (!pid) { errs[a.address] = T.noProc; delete this.cache[a.address]; continue; }
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
    if (this.meetVisits?.has(addr)) return this.meetVisits.get(addr);       // called to a meeting
    const m = this.msgs.filter((x) => x.from === addr && x.at && !x.isReply && !x.meeting).pop();
    if (!m) return null;
    const reply = m.reply && start(m.reply) <= now ? m.reply : null;       // a reply only counts once it is there
    let until = reply ? start(reply) + AFTER_REPLY_MS : start(m) + VISIT_MS;
    if (!reply && !m.reply) {   // not every message is a question
      const host = agents().find((a) => a.address === m.to);
      // idle/done again → walk home; busy working on it (took the job) → walk home a little after arriving
      if (host && (host.status === "idle" || host.status === "done")) until = Math.min(until, Math.max(start(m) + GIVE_UP_MS, now));
      else if (host && host.status === "working") until = Math.min(until, Math.max(start(m) + DEPART_MS + RISE_MS + WALK_MS + WORK_GIVE_UP_MS, now));
    }
    return { m, reply, active: now < until, until };
  }

  // One sender to two or more others within MEET_WINDOW_MS: a meeting. The others come to the sender (it
  // stays put), stand around it, and go back after MEET_HOLD_MS. No hearts: nothing is done yet — a later
  // answer from one of them is a normal visit to the sender, thanked with an automatic "✓". In a crowded
  // field the meeting collapses: nobody walks, the sender shows the meeting and the others a ⌂ tag.
  buildMeetings(now, usable) {
    this.meetings = []; this.meetVisits = new Map(); this.meetHost = new Map(); this.meetMember = new Map();
    const qs = this.msgs.filter((m) => !m.isReply && m.at).sort((x, y) => start(x) - start(y));
    const byFrom = new Map();
    for (const m of qs) { if (!byFrom.has(m.from)) byFrom.set(m.from, []); byFrom.get(m.from).push(m); }
    for (const [from, ms] of byFrom) {
      let cl = [];
      const flush = () => {
        const to = [...new Set(cl.map((m) => m.to))].filter((x) => x !== from);
        if (to.length >= 2) {
          for (const m of cl) m.meeting = true;
          const members = to.map((addr) => ({ addr, m: cl.find((m) => m.to === addr) }));
          const end = Math.max(...members.map((x) => start(x.m))) + (members.length - 1) * 700 + DEPART_MS + RISE_MS + WALK_MS + MEET_HOLD_MS + 1500;
          this.meetings.push({ host: from, members, s0: start(cl[0]), end, text: cl[0].text });
        }
        cl = [];
      };
      for (const m of ms) { if (cl.length && start(m) - start(cl[0]) > MEET_WINDOW_MS) flush(); cl.push(m); }
      flush();
    }
    // answers to a meeting's tasks come later as normal visits to the sender, thanked automatically
    // Several reports to the same one that overlap (the next arrives before the thanks of the earlier) are
    // thanked together: everybody waits beside it until the last has reported, then one "✓ thanks ×N",
    // all hop together and go home together.
    const reports = [];
    for (const q of this.msgs) {
      if (!q.meeting || !q.reply) continue;
      const r = q.reply; q.reply = null; r.isReply = false; r.report = true;
      reports.push({ r, host: q.from, ready: start(r) + DEPART_MS + RISE_MS + WALK_MS + 3000 });
    }
    reports.sort((a, b) => start(a.r) - start(b.r));
    const clusters = [];
    for (const x of reports) {
      const c = clusters.find((c) => c.host === x.host && start(x.r) < c.at);
      if (c) { c.members.push(x); c.at = Math.max(c.at, x.ready); } else clusters.push({ host: x.host, members: [x], at: x.ready });
    }
    for (const c of clusters) {
      const n = c.members.length, text = n > 1 ? `${T.thanks} ×${n}` : T.thanks;
      for (const x of c.members) x.r.reply = { from: c.host, to: x.r.from, at: c.at, text, synthetic: true };
    }
    const live = this.meetings.filter((M) => now < M.end + WALK_MS);
    const crowd = false;   // a meeting needs one slot only (members stack), so it never has to collapse
    for (const M of live) {
      M.collapsed = crowd;
      if (now < M.end) this.meetHost.set(M.host, M);
      // nearest first: it takes the bottom of the stack and arrives first; the farthest sets off last,
      // sits on top and is the first to leave — so nobody runs into anybody, coming or going
      const idx = (addr) => { const p = this.lay?.slotOf?.(addr); return p != null && p >= 0 ? p : agents().findIndex((a) => a.address === addr); };
      const hi = idx(M.host);
      this.meetOrder = this.meetOrder || new Map();
      const okey = `${M.host}@${M.s0}`;
      if (!this.meetOrder.has(okey))
        this.meetOrder.set(okey, [...M.members].sort((p, q) => Math.abs(idx(p.addr) - hi) - Math.abs(idx(q.addr) - hi)).map((x) => x.addr));
      const order = this.meetOrder.get(okey);
      M.members.sort((p, q) => order.indexOf(p.addr) - order.indexOf(q.addr));
      const base = Math.max(...M.members.map((x) => start(x.m)));
      M.members.forEach((x, k) => { x.go = base + k * 700; });   // walk start minus DEPART_MS
      M.arrive = M.members.map((x) => x.go + DEPART_MS + RISE_MS + WALK_MS);
      for (const [k, x] of M.members.entries()) {
        if (crowd) { if (now < M.end) this.meetMember.set(x.addr, M); continue; }
        // they leave one after another, top of the stack first, so they never start in a heap
        const until = M.end;
        this.meetVisits.set(x.addr, { m: { from: x.addr, to: M.host, at: x.go, seen: 0, text: "" }, reply: null,
          active: now < until, until, meeting: M, k });
      }
    }
    if (live.length) this.kick = true;
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
    const gw = this.lay?.spriteW ?? SPRITE_W;
    let g = v_flex().id(`ghost-${v.m.from}`).w(gw).items_center().gap(2)
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
        .child(div().text_size(10).text_color(t.dim).child(`${id} · ${T.guest}`)));
  }

  // Floats above the daemon without widening its column (a wider column would shift every slot).
  // edge: -1 at the field's left end (bubble opens rightwards), 1 at the right end (opens leftwards), 0 centred
  bubbleSay(t, text, col, edge = 0, lvl = 0, maxW = 210, side = 0) {
    const w = this.lay?.spriteW ?? SPRITE_W;
    const bw = Math.round(Math.min(maxW, Math.max(130, Math.min(210, (this.lay?.slot ?? 200) * 2 - 16))));
    const left = side > 0 ? w * 0.75 : side < 0 ? w * 0.25 - bw : edge < 0 ? 0 : edge > 0 ? w - bw : (w - bw) / 2;
    return div().relative().w(w).h(16).child(this.bubbleCard(t, text, col, bw).absolute().bottom(lvl * 34).left(left));
  }

  // Is slot position p near an end of the field, where a centred 210 px bubble would be cut off?
  edgeOf(p) {
    const L = this.lay; if (!L) return 0;
    const centre = (p + 0.5) * L.slot, half = 105 - 20;   // 20 px field padding
    return centre < half ? -1 : centre > L.slots * L.slot - half ? 1 : 0;
  }

  bubbleCard(t, text, col, bw = 210) {
    return v_flex().w(bw).items_center()
      .child(div().max_w(bw).px(8).py(4).rounded(8).border_1().border_color(col).bg(t.popover)
        .text_size(11).text_color(t.foreground).child(`${T.q[0]}${text.slice(0, 64)}${text.length > 64 ? "…" : ""}${T.q[1]}`))
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
      const why = a.app !== "claude-code" ? T.noData
        : err ? `${T.unreadable}: ${err}` : T.reading;
      return body.child(div().text_color(err ? t.blocked : t.dim).child(why));
    }
    const pct = Math.min(1, it.ctx / CONTEXT_WINDOW);
    const barCol = pct > 0.8 ? t.blocked : pct > 0.5 ? t.done : t.accent;
    const sent = this.msgs.filter((m) => m.from === a.address);
    const got = this.msgs.filter((m) => m.to === a.address);
    const last = [...sent, ...got].sort((x, y) => (y.at || 0) - (x.at || 0))[0];

    body = body
      .child(div().h(1).bg(t.border))
      .child(row(T.context, `${kTok(it.ctx)} / ${kTok(CONTEXT_WINDOW)}`, barCol))
      .child(div().h(6).w(236).rounded(3).bg(t.raised)
        .child(div().h(6).rounded(3).bg(barCol).w(Math.max(3, Math.round(236 * pct)))))
      .child(row(T.usage, `${Math.round(pct * 100)}%`, barCol))
      .child(row("output (log)", kTok(it.out)))
      .child(row(T.model, (it.model || "?").replace(/^claude-/, "")))
      .child(row(T.lastAnswer, it.at ? ago(it.at) : "–"))
      .child(row("session", it.session || "–", t.muted))
      .child(div().h(1).bg(t.border))
      .child(row(T.sent, String(sent.length)))
      .child(row(T.received, String(got.length)));
    if (last) {
      const dir = last.from === a.address ? `⇢ ${this.nameOf(last.to)}` : `⇠ ${this.nameOf(last.from)}`;
      body = body
        .child(div().text_color(t.muted).text_size(11).child(`${dir} · ${clock(last.at)}`))
        .child(div().text_color(t.dim).text_size(11).child(`${T.q[0]}${last.text.slice(0, 70)}…${T.q[1]}`));
    }
    return body;
  }

  daemon(t, a, now, el, vw) {
    const look = LOOK[a.status] ?? LOOK.idle;
    const c = this.color(t, a.status);
    const h = hash(a.address);
    const L = this.lay;                       // slot width, sprite width, face size for this field
    // drift only as far as the free space beside it allows (never into a neighbour)
    const roam = Math.min(40 + (h % 30), Math.max(0, (L.slot - L.boxW) / 2 - 4));

    let el2 = v_flex().id(`d-${a.address}`).relative().w(L.spriteW).items_center().gap(2)
      .cursor_pointer().on_click(() => run("agent.focus", { terminal: a.address }));
    // Position comes only from the committed stage (see stage.js): its x, and a trip if it is travelling.
    const visit = this.visitOf(a.address, now);
    const isCaller = !!(el.away && visit && visit.m.from === a.address);
    const mt = isCaller ? L.meetOf?.(a.address) : null;
    const st = vw.st, x = vw.x;
    const walking = !!(st && st.up);
    const arrived = el.away && (!st || st.landed);
    let pos = this.placed(`p-${a.address}`, x, st ? st.glide : (this.stage?.shift ?? CFG.SHIFT_MS), null, false, st && st.linear ? "linear" : "ease-in-out");
    // drifting only while the stage is still and nobody is talking, and never into a neighbour
    if (!el.away && !st && !this.stage.tx && a.status === "working" && !L.talking && roam >= 4)
      pos = pos.loop("left", { from: (x - roam) * L.zoom, to: (x + roam) * L.zoom, period: 5200 + (h % 2600), easing: "ease-in-out" });   // loop() values aren't zoomed, left() is
    // a meeting member is small from the moment it rises, and comes down straight onto its place in the
    // stack in front of the supervisor (never full size on the ground, where another one already stands)
    const rose = !!(vw.tr && now >= vw.tr.tUp), landedHome = !!(vw.tr && el.returning && now >= vw.tr.tArr);
    const member = !!(el.meta?.meeting && (el.away || (el.returning && !landedHome)));
    const stacked = member && !walking;
    el2 = el2.transition("top", { duration: CFG.RISE_UP_MS, easing: "ease-out" })
      .top(walking ? -(LANE_UP - 8 + (vw.tr?.lane ?? 0) * 18) : stacked ? -(el.meta.stack ?? 0) * STACK_H : 0);
    const form = st?.form ?? "daemon";
    const tagOn = !!(st && vw.tr && now >= vw.tr.tUp && now < vw.tr.tArr - TAG_OFF_MS);   // only while up on the track
    if (a.status === "blocked" && !walking)   // its bounce would override the lane: walking it stays up
      el2 = el2.loop("top", { from: -12, to: 0, period: 520, easing: "ease-out" });
    if (a.status === "idle")
      el2 = el2.loop("opacity", { from: 0.45, to: 0.85, period: 3200 + (h % 1200) });

    const sentNow = this.msgs.filter((m) => m.from === a.address && now - m.at < LIVE_MS).pop();
    const inn = this.msgs.filter((m) => m.to === a.address && now - m.at < LIVE_MS).pop();

    let bubble;
    if (a.status === "blocked") {
      bubble = div().px(6).rounded(4).bg(t.blocked).text_color(t.accent_foreground).text_size(11).font_weight(700)
        .whitespace_nowrap().truncate().max_w(L.spriteW).child(L.slot < 110 ? "!" : `! ${a.app ?? "agent"}`).loop("opacity", { from: 0.55, to: 1, period: 700 });
    } else if (this.meetHost.get(a.address)) {
      const M = this.meetHost.get(a.address), n = M.members.length;
      // once all are really there: every member committed beside it and its trip landed
      const landed = (addr) => { const e = this.stage?.els.get(`a:${addr}`); if (!e || !e.away || !e.meta?.meeting) return false;
        const tr = e.trip && this.stage.trips.get(e.trip); return !tr || now >= tr.tDown; };
      if (M.members.every((x) => landed(x.addr)) && !M.allAt) M.allAt = now;
      this.allAt = this.allAt || new Map(); const ak = `${M.host}@${M.s0}`;
      if (M.allAt && !this.allAt.has(ak)) this.allAt.set(ak, M.allAt);
      const first = this.allAt.get(ak) ?? Infinity;
      const anyArrived = now >= first && now < first + 3500;
      bubble = now >= first + 3500 ? div().h(16) : anyArrived
        ? this.bubbleSay(t, `⌂ ${T.tasks(n)}`, t.accent, this.edgeOfX(x), 0, 96)   // short: the task itself is in the ticker
        : div().px(6).rounded(4).border_1().border_color(t.accent).text_color(t.accent).text_size(11).font_family("Hack")
            .whitespace_nowrap().truncate().max_w(L.spriteW).child(`⌂ ${n}`).loop("opacity", { from: 0.5, to: 1, period: 600 });
    } else if (this.meetMember.get(a.address)) {
      bubble = div().px(6).rounded(4).border_1().border_color(t.accent).text_color(t.accent).text_size(11).font_family("Hack")
        .whitespace_nowrap().truncate().max_w(L.spriteW).child(`⌂ ${this.nameOf(this.meetMember.get(a.address).host)}`)
        .loop("opacity", { from: 0.5, to: 1, period: 600 });
    } else if (isCaller && visit.meeting) {
      const M = visit.meeting, top = (mt?.stack ?? 0) === M.members.length - 1;
      const ayeAt = (this.allAt?.get(`${M.host}@${M.s0}`) ?? Infinity) + 3500;
      bubble = arrived ? (top && now >= ayeAt && visit.active ? div().px(6).rounded(4).border_1().border_color(t.done).bg("#d9cf8c22").text_color(t.done).text_size(11)
          .font_family("Hack").whitespace_nowrap().child(`${T.aye}${M.members.length > 1 ? " ×" + M.members.length : ""}`)
          .loop("opacity", { from: 0.7, to: 1, period: 500 }) : div().h(16))
        : !tagOn ? div().h(16) : div().px(6).rounded(4).border_1().border_color(t.accent).text_color(t.accent).text_size(11).font_family("Hack")
            .whitespace_nowrap().truncate().max_w(L.spriteW).child(a.space_name);
    } else if (isCaller) {
      // the question only once it has arrived beside its partner; on the way just a small tag
      bubble = visit.reply ? div().h(16)
        : arrived ? this.bubbleSay(t, visit.m.text, t.accent, this.edgeOfX(x), Math.round(x / Math.max(1, L.slot)) % 2)
        : !tagOn ? div().h(16) : div().px(6).rounded(4).border_1().border_color(t.accent).text_color(t.accent).text_size(11).font_family("Hack")
            .whitespace_nowrap().truncate().max_w(L.spriteW).child(a.space_name);
    } else if (this.answering(a.address, now)) {
      const r = this.answering(a.address, now);
      bubble = r.reply ? (now - start(r.reply) < ANSWER_MS ? this.bubbleSay(t, r.reply.text, t.done, this.edgeOfX(x), Math.round(x / Math.max(1, L.slot)) % 2) : div().h(16))
        : div().h(16).text_size(11).text_color(c).opacity(0.8).frames(look.note, look.noteMs);
    } else {
      bubble = div().h(16).text_size(11).text_color(c).opacity(0.8).frames(look.note, look.noteMs);
    }

    const it = this.info[a.address];
    const pct = it?.ctx != null ? Math.min(1, it.ctx / CONTEXT_WINDOW) : null;
    const answered = this.answering(a.address, now);
    const thanks = (v) => v && v.reply && now - start(v.reply) >= ANSWER_MS;
    const love = (visit?.active && thanks(visit)) || (answered && thanks(answered));
    // both hop together, three times, then it's over
    if (love) el2 = el2.loop("top", { from: 0, to: -12, period: HOP_MS, easing: "ease-out" });
    let body;
    if (form === "packet") {          // a data packet with a light trail, flying past the other one
      const trail = st.dir > 0 ? ["  ·◆", " ··◆", "···◆", " ··◆"] : ["◆·  ", "◆·· ", "◆···", "◆·· "];
      body = div().px(2).text_size(Math.round(L.face * 0.75)).font_family("Hack").font_weight(700).text_color(t.accent)
        .whitespace_nowrap().frames(trail, 70).loop("opacity", { from: 0.7, to: 1, period: 240 });
    } else if (form === "morph") {    // glitching between daemon and packet
      body = div().px(4).py(1).rounded(3).border_1().border_color(t.accent).bg("#7ddcb422")
        .text_size(Math.round(L.face * 0.6)).font_family("Hack").font_weight(700).text_color(t.accent).whitespace_nowrap()
        .frames(["[▚▞]", "<▞▚>", "[░▒]", "<▓>", "▚◆▞"], 45).loop("opacity", { from: 0.4, to: 1, period: 120 });
    } else {
      body = div().px(8).py(2).rounded(6).border_1().border_color(love ? "#ff7ab6" : c)
        .bg(a.focused ? t.selected : "#050d0ab0")
        .text_size(member || walking ? Math.round(L.face * 0.6) : L.face).font_family("Hack").font_weight(700).text_color(love ? "#ff7ab6" : c).whitespace_nowrap()
        .frames(love ? LOVE.face : look.face, love ? LOVE.ms : look.ms);
    }
    if (tagOn && walking && form === "daemon" && !isCaller)   // going home: its own name on top
      bubble = div().px(6).rounded(4).border_1().border_color(t.accent).text_color(t.accent).text_size(11).font_family("Hack")
        .whitespace_nowrap().truncate().max_w(L.spriteW).child(a.space_name);
    if (form !== "daemon") bubble = div().h(16);   // packets carry no tags
    const meter = div().h(2).w(64).rounded(1).bg(t.raised)
      .child(div().h(2).rounded(1).bg(pct == null ? t.raised : pct > 0.8 ? t.blocked : pct > 0.5 ? t.done : t.accent)
        .w(pct == null ? 0 : Math.max(2, Math.round(64 * pct))));

    const label = v_flex().items_center().opacity(walking || stacked || el.leaving ? 0 : 1)
      .child(div().text_size(11).text_color(t.foreground).truncate().max_w(L.spriteW).child(a.space_name))
      .child(div().text_size(10).text_color(t.dim).truncate().max_w(L.spriteW).child(`${a.tab_name} · ${look.word}`));

    el2 = el2.child(bubble).child(body).child(form === "daemon" ? meter : div().h(2)).child(label);
    return pos.child(HoverCard.new(`hc-${a.address}`).open_delay(250).close_delay(150).anchor("top_center")
      .trigger(el2).content(this.card(t, a)));
  }

  // ---------------------------------------------------------------------------------------------
  // The script ("Drehbuch"). A change of place is a trip, planned once and then never changed: rise onto
  // the upper track, travel at a constant speed (nobody overtakes), come down. Where two trips would meet
  // head-on, the later one is timed so they meet at a switch (1–3, by width); around it both travel as
  // data packets and pass each other. The layout under them stays frozen while anyone is on the track.
  // ---------------------------------------------------------------------------------------------
  switches() {
    const w = this.lay ? this.lay.slot * this.lay.slots : 1200;
    const n = w < 1400 ? 1 : w < 2600 ? 2 : 3;
    return Array.from({ length: n }, (_, k) => 20 + w * (k + 0.5) / n);
  }

  // a bubble near an end of the field opens inwards
  edgeOfX(x) {
    const L = this.lay; if (!L) return 0;
    const centre = x + L.spriteW / 2, half = 105, w = L.slot * L.slots + 40;
    return centre < half ? -1 : centre > w - half ? 1 : 0;
  }

  // A positioned wrapper. A freshly mounted element would animate its `left` in from 0 (the field's left
  // edge), so the first frame of a new one stands still where it comes from — the group it just left, or
  // its own slot — and only the next frame moves it, with the transition.
  placed(id, x, ms, from, hold = false, easing = "ease-in-out") {
    const seen = this.seenX?.has(id);
    const at = hold || seen ? x : (from ?? x);
    this.nextSeenX.set(id, at);
    let el = div().id(id).absolute().bottom(8).left(at);
    // GPUI animates only changes *after* a transition is attached, so it is attached from the second render
    // on — also while holding still — and the first move after a hold glides instead of jumping
    if (seen) el = el.transition("left", { duration: ms, easing });
    else this.kick = true;                         // a second render soon, to attach it
    return el;
  }

  // Daemons of one status gathered in one slot, when the field is too narrow for each to have its own:
  // idle ones camp at a fire, working ones share a LAN party, done ones sleep in a tent, and those that
  // need you crowd together waving (grouped last, so they stay visible on their own the longest).
  statusGroup(t, st, group) {
    const L = this.lay, n = group.length;
    const chars = { idle: 13, working: 11, done: 5, blocked: 10 }[st];
    const f = Math.max(8, Math.min(L.face, Math.floor((L.fitSlot - 40) / (chars * 0.66))));   // the scene fits its slot
    const col = this.color(t, st);
    const fire = "#ffb36b", ember = "#ff7a45";
    const scene = {
      idle: h_flex().gap(4).items_end()
        .child(div().text_color(t.idle).frames(["[·_·]", "[·_·]", "[-_-]"], 900))
        .child(v_flex().items_center()
          .child(div().text_size(Math.round(f * 0.8)).text_color(fire).frames(["ʌ", "ʎ", "^", "ʌ"], 180).loop("opacity", { from: 0.6, to: 1, period: 420 }))
          .child(div().text_size(Math.round(f * 0.6)).text_color(ember).child("≈")))
        .child(div().text_color(t.idle).frames(["[-_-]", "[·_·]", "[·_·]"], 1100)),
      working: h_flex().gap(2).items_center()
        .child(div().text_color(t.working).child("[>_"))
        .child(div().w(Math.round(f * 1.6)).text_size(Math.round(f * 0.7)).text_color(t.accent).frames(["⇄  ", " ⇄ ", "  ⇄", " ⇄ "], 160))
        .child(div().text_color(t.working).child("_<]")),
      done: h_flex().gap(4).items_end()
        .child(div().text_color(t.done).child("/\\"))
        .child(div().text_size(Math.round(f * 0.6)).text_color(t.done).frames(["z", "zZ", "zZz", " "], 600)),
      // panic: faces flipping, an alarm light, the whole group shaking
      blocked: h_flex().gap(4).items_center()
        .child(div().text_size(Math.round(f * 0.7)).text_color(t.blocked).frames(["◉", " ", "◉", "○"], 200))
        .child(div().text_color(t.blocked).frames(["[°□°]", "[⊙▂⊙]", "[>□<]", "[°□°]", "[⊙_⊙]"], 170))
        .child(div().text_size(Math.round(f * 0.7)).text_color(t.blocked).frames(["!!", "! ", "!!", " !"], 150)),
    }[st];
    const gw = Math.max(48, L.fitSlot - 12);               // never wider than its slot (no reaching into a neighbour)
    let el = v_flex().id(`d-group-${st}`).relative().w(gw).max_w(gw).overflow_hidden().items_center().gap(2).cursor_pointer()
      .on_click(() => run("agent.focus", { terminal: group[0].address }));
    if (st === "blocked") el = el.loop("left", { from: -3 * L.zoom, to: 3 * L.zoom, period: 130, easing: "linear" })   // shaking
      .loop("top", { from: -6, to: 0, period: 430, easing: "ease-out" });
    el = el
      .child(st === "blocked"
        ? div().px(6).rounded(4).bg(t.blocked).text_color(t.accent_foreground).text_size(11).font_weight(700)
            .child("!").loop("opacity", { from: 0.55, to: 1, period: 700 })
        : div().h(16))
      .child(h_flex().px(8).py(2).gap(4).items_center().rounded(6).border_1().border_color(col).bg("#050d0ab0")
        .text_size(f).font_family("Hack").font_weight(700).whitespace_nowrap()
        .child(scene))
      .child(div().h(2).w(64))
      .child(v_flex().items_center()
        .child(div().text_size(11).text_color(t.foreground).child(`${n} ${st === "blocked" ? T.needYou : T[st]}`))
        .child(div().text_size(10).text_color(t.dim).truncate().max_w(L.spriteW).child(group.map((a) => a.space_name).join(", "))));
    const card = v_flex().w(220).p(12).gap(4).rounded(8).border_1().border_color(col).bg(t.popover)
      .text_size(12).font_family("Hack").text_color(t.foreground)
      .child(div().text_color(t.muted).child(`${n} ${st === "blocked" ? T.needYou : T[st]}`))
      .child(div().h(1).bg(t.border))
      .children(group.map((a) => h_flex().id(`g-${a.address}`).justify_between().gap(12).cursor_pointer()
        .hover((x) => x.bg(t.hover)).on_click(() => run("agent.focus", { terminal: a.address }))
        .child(div().child(a.space_name)).child(div().text_color(t.dim).child(a.tab_name))));
    return HoverCard.new(`hc-group-${st}`).open_delay(250).close_delay(150).anchor("top_center").trigger(el).content(card);
  }

  ticker(t, now) {
    const recent = this.msgs.filter((m) => m.at && now - m.at < RECENT_MS).slice(-3).reverse();
    if (recent.length === 0)
      return h_flex().flex_none().h(18).px(14).text_size(11).font_family("Hack").text_color(t.dim)
        .child(T.quiet);
    return h_flex().flex_none().h(18).px(14).gap(18).text_size(11).font_family("Hack").overflow_hidden()
      .children(recent.map((m, i) => {
        const live = now - m.at < LIVE_MS;
        return h_flex().id(`tk-${i}`).gap(6).flex_none().text_color(live ? t.accent : t.dim)
          .child(div().child(this.nameOf(m.from)))
          .child(live ? div().w(36).frames(PACKET, 160) : div().child("⇢"))
          .child(div().child(this.nameOf(m.to)))
          .child(div().text_color(t.dim).child(`${clock(m.at)} ${T.q[0]}${m.text.slice(0, 34)}…${T.q[1]}`));
      }));
  }

  render() {
    const t = theme();
    const list = agents();
    const now = Date.now();
    this.nextSeenX = new Map();
    const demo = this.demo.filter((m) => m.at <= now);
    this.msgs = [...(this.real || []), ...demo].map((m) => ({ ...m })).sort((x, y) => x.at - y.at);
    this.pairUp(this.msgs);
    this.buildMeetings(now, Math.max(200, (this.width || 1200) / (Number(settings().zoom) || 1) - 40));

    setAgentOrder(list.map((a) => a.address));
    const count = (s) => list.filter((a) => a.status === s).length;

    const header = h_flex().flex_none().h(24).px(14).justify_between().items_center()
      .text_size(11).font_family("Hack").text_color(t.dim)
      .child(h_flex().gap(8)
        .child(div().text_color(t.accent).frames(["▌", " "], 600))
        .child(div().text_color(t.muted).child(`THE GRID · ${list.length} daemon${list.length === 1 ? "" : "s"}`)))
      .child((this.width || 1200) / (Number(settings().zoom) || 1) < 700   // narrow field: counts only
        ? h_flex().gap(8)
          .child(div().text_color(t.working).child(`▸${count("working")}`))
          .child(div().text_color(t.blocked).child(`!${count("blocked")}`))
          .child(div().text_color(t.done).child(`✓${count("done")}`))
          .child(div().text_color(t.idle).child(`·${count("idle")}`))
        : h_flex().gap(14)
          .child(div().text_color(t.working).child(`▸ ${count("working")} ${T.working}`))
          .child(div().text_color(t.blocked).child(`! ${count("blocked")} ${T.blocked}`))
          .child(div().text_color(t.done).child(`✓ ${count("done")} ${T.done}`))
          .child(div().text_color(t.idle).child(`· ${count("idle")} ${T.idle}`)));

    // Layout: one slot per daemon; too narrow → idle ones share one slot (not those in a visit); still too
    // narrow → everything shrinks. on_size_change reports zoomed pixels, slots are in unzoomed ones.
    const zoom = Number(settings().zoom) || 1;
    const usable = Math.max(200, (this.width || 1200) / zoom - 40);
    const busy = new Set();
    // Partners of a visit stay members of their group. One that is gathered steps out of the group for the
    // visit — straight from the group's place to where it has to be — and goes straight back into it.
    const inVisit = new Map();                            // address -> visit it is part of (until the caller is home)
    for (const a of list) {
      const v = this.visitOf(a.address, now);
      if (v?.active) { inVisit.set(v.m.from, v); inVisit.set(v.m.to, v); }   // the way back is the planner's
    }
    // Too narrow → gather by status, one status at a time until it fits: idle (campfire), working (LAN
    // party), done (tent), and last those that need you.
    let shown = list;
    const groups = [];                                    // [{ st, members }]
    const extra = 0;   // visits never change which groups exist (that would reshuffle the field mid-walk)
    // (no freezing here: the planner only takes a new layout when its current step is over)
    for (const st of ["idle", "working", "done", "blocked"]) {
      if (usable / (shown.length + groups.length + extra) >= MIN_SLOT) break;
      const members = shown.filter((a) => a.status === st);
      if (members.length < 2) continue;
      groups.push({ st, members });
      shown = shown.filter((a) => !members.includes(a));
    }
    const grouped = new Set(groups.flatMap((g) => g.members.map((m) => m.address)));
    // Slots: every shown daemon and every group; a gathered agent being visited gets an "out" slot beside
    // its group; a caller gets a reserved spot beside the one it asks (on its side), so nobody overlaps.
    const items = shown.map((a) => ({ kind: "agent", a }));
    for (const g of ["blocked", "working", "done", "idle"].map((st) => groups.find((x) => x.st === st)).filter(Boolean))
      items.push({ kind: "group", g });
    const groupIdx = (addr) => items.findIndex((x) => x.kind === "group" && x.g.members.some((m) => m.address === addr));
    const posOf = (addr) => {
      const k = items.findIndex((x) => (x.kind === "agent" || x.kind === "out") && x.a.address === addr);
      return k >= 0 ? k : groupIdx(addr);
    };
    const visitsNow = [...new Set(inVisit.values())];
    // the meeting point stays in front of the group the asked one was in when the visit began, even if
    // its status (and so its group) changes meanwhile; only the way back goes to its group of now
    this.outOrigin = this.outOrigin || new Map();
    // one out-slot per asked agent, however many come to it (timing spans all of its visitors)
    visitsNow.sort((x, y) => start(x.m) - start(y.m));
    const byTarget = new Map();
    for (const v of visitsNow) { if (!byTarget.has(v.m.to)) byTarget.set(v.m.to, []); byTarget.get(v.m.to).push(v); }
    const settled = (v) => now >= start(v.m) + DEPART_MS - SHIFT_MS;   // room only once it is clear where they meet
    for (const [to, vs] of byTarget) {
      if (!grouped.has(to) || !vs.some(settled)) continue;
      const a = list.find((x) => x.address === to); if (!a) continue;
      const key = `${to}@${vs[0].m.at}`;
      if (!this.outOrigin.has(key)) this.outOrigin.set(key, a.status);
      const og = items.findIndex((x) => x.kind === "group" && x.g.st === this.outOrigin.get(key));
      const v = { m: vs[0].m, until: Math.max(...vs.map((x) => x.until)) };
      items.splice(og >= 0 ? og : groupIdx(to), 0, { kind: "out", a, v });   // steps out, left of that group
    }
    // several callers to the same one: 1st on its own side, 2nd on the other side, 3rd on the 1st side one
    // step further out, … each gets a reserved slot on its side so nobody stands on anybody
    const spots = new Map(), meet = new Map(), level = new Map(), rank = new Map();
    const meetSlot = new Map();   // supervisor -> its one stack slot
    for (const [n, v] of visitsNow.entries()) {
      if (!settled(v)) continue;
      const caller = v.m.from, tp = posOf(v.m.to), vp = posOf(caller);
      if (v.meeting) {
        if (tp < 0 || vp < 0) continue;
        let ms = meetSlot.get(v.m.to);
        if (!ms) {
          const dir = tp >= items.length - 1 ? -1 : 1;    // in front of it: right, or left at the field's end
          ms = { sp: { kind: "spot", visitor: `meet:${v.m.to}` }, dir };
          items.splice(dir < 0 ? tp : tp + 1, 0, ms.sp); meetSlot.set(v.m.to, ms);
        }
        spots.set(caller, ms.sp); meet.set(caller, { to: v.m.to, dir: ms.dir, dist: 1, stack: v.k ?? 0 });
        continue;
      }
      if (tp < 0 || vp < 0 || tp === vp && !grouped.has(caller)) continue;
      // the side with fewer visitors already standing there (own side on a tie), one step further out
      const side = rank.get(v.m.to) ?? { "-1": 0, "1": 0 }; rank.set(v.m.to, side);
      const nat = vp < tp ? -1 : 1, dir = nat;   // own side only: the far side would push the one asked aside
      side[dir] += 1;
      const dist = side[dir], k = side[-1] + side[1] - 1;
      level.set(`${caller}>${v.m.to}`, (n + k) % 2);   // neighbouring bubbles on alternating heights
      const sp = { kind: "spot", visitor: caller };
      items.splice(dir < 0 ? tp : tp + 1, 0, sp);
      spots.set(caller, sp); meet.set(caller, { to: v.m.to, dir, dist });
    }
    for (const a of shown) {
      const g = this.guestFor(a.address, now);
      if (!g) continue;
      const tp = posOf(a.address);
      items.splice(tp === items.length - 1 ? tp : tp + 1, 0, { kind: "ghost", v: g });
    }
    const slots = Math.max(1, items.length);
    const slot = usable / slots, scale = Math.min(1, Math.max(0.6, slot / MIN_SLOT));
    // sprites are sized for the narrowest slot of the last few seconds: while the planner still shows the
    // old (denser) positions, a sprite sized for the new (wider) slots would reach into its neighbour
    this.slotHist = (this.slotHist || []).filter((h) => now - h.t < 4000); this.slotHist.push({ t: now, slot });
    const fitSlot = Math.min(...this.slotHist.map((h) => h.slot));
    const face = Math.round(18 * Math.min(scale, Math.min(1, Math.max(0.6, fitSlot / MIN_SLOT)))), spriteW = Math.min(SPRITE_W, Math.max(56, fitSlot - 8));
    this.lay = {
      slot, slots, spriteW, face, boxW: face * 0.62 * 5 + 18, fitSlot,
      slotOf: posOf,
      spotOf: (addr) => (spots.has(addr) ? items.indexOf(spots.get(addr)) : -1),
      meetOf: (addr) => meet.get(addr),
      // not planned as a visit (e.g. reports in a meeting): neighbours alternate by their place on the field
      levelOf: (from, to, x) => level.get(`${from}>${to}`) ?? (x == null ? 0 : Math.round(x / Math.max(1, slot)) % 2),
      xOf: (p) => 20 + p * slot + (slot - spriteW) / 2, zoom,
      talking: items.some((x) => x.kind === "spot" || x.kind === "ghost"),
      grouped,
    };
    // ---- the desired layout, handed to the planner (stage.js); only the committed stage is drawn ----
    const xOf = this.lay.xOf, gid = (addr) => { const g = groups.find((x) => x.members.some((m) => m.address === addr)); return g ? `g:${g.st}` : null; };
    const meetXOf = (addr, to) => {
      const tp = posOf(to), mt = meet.get(addr), sp = spots.get(addr);
      if (tp < 0 || !sp) return null;
      const target = items.indexOf(sp);
      return xOf(tp) + (mt ? mt.dir * mt.dist : Math.sign(target - tp)) * Math.min(slot, spriteW + 12);
    };
    const metaOf = (addr, v) => v && v.meeting && v.m.from === addr ? { meeting: true, stack: meet.get(addr)?.stack ?? v.k ?? 0, host: v.m.to } : null;
    const desired = [];
    items.forEach((it, p) => {
      if (it.kind === "spot") return;
      if (it.kind === "group") { desired.push({ id: `g:${it.g.st}`, x: xOf(p), item: it }); return; }
      if (it.kind === "ghost") { desired.push({ id: `h:${it.v.m.from}`, x: xOf(p), item: it }); return; }
      if (it.kind === "out") { desired.push({ id: `a:${it.a.address}`, x: xOf(p), item: { kind: "agent", a: it.a }, travel: true, originId: gid(it.a.address) }); return; }
      const v = inVisit.get(it.a.address), mx = v && v.m.from === it.a.address ? meetXOf(it.a.address, v.m.to) : null;
      desired.push({ id: `a:${it.a.address}`, x: mx ?? xOf(p), item: it, travel: mx != null, meta: metaOf(it.a.address, v) });
    });
    for (const v of visitsNow) {                           // callers out of a group
      if (!grouped.has(v.m.from) || desired.some((d) => d.id === `a:${v.m.from}`)) continue;
      const a = list.find((x) => x.address === v.m.from), mx = a && meetXOf(v.m.from, v.m.to);
      if (mx != null) desired.push({ id: `a:${v.m.from}`, x: mx, item: { kind: "agent", a }, travel: true, originId: gid(v.m.from), meta: metaOf(v.m.from, v) });
    }
    desired.sort((p, q) => p.x - q.x);
    const groupXNow = (addr) => { const k = items.findIndex((x) => x.kind === "group" && x.g.members.some((m) => m.address === addr)); return k >= 0 ? xOf(k) : null; };
    this.stage = this.stage || newStage();
    const cfg = { ...CFG, SPEED: Math.max(0.42, usable / 3800) };   // px/ms, so wide screens aren't slow
    plan(this.stage, desired, {
      now, slot, switches: this.switches(),
      destOf: (id) => id.startsWith("a:") ? groupXNow(id.slice(2)) : null,
      destIdOf: (id) => id.startsWith("a:") ? gid(id.slice(2)) : null,   // the group it goes into (to meet it where it is)
    }, cfg);

    // ---- draw the committed stage ----
    const own = new Set([...this.stage.els.values()].filter((e) => !e.leaving && e.id.startsWith("a:")).map((e) => e.id.slice(2)));
    const onTrackBox = (vw) => vw.st && vw.st.up;
    const field = list.length === 0
      ? h_flex().flex_1().justify_center().items_center().text_size(12).font_family("Hack").text_color(t.dim)
          .frames([`${T.empty} ▮`, `${T.empty}  `], 600)
      : div().relative().flex_1().min_h(0)
          .children([...this.stage.els.values()].map((e) => {
            const vw = view(this.stage, e, now);
            if (vw.hidden) return null;
            if (e.leaving && vw.tr && now >= vw.tr.tDown) return null;  // came down into its group: merged, gone
            if (e.id.startsWith("a:")) {
              const a = list.find((x) => x.address === e.id.slice(2));
              return a ? this.daemon(t, a, now, e, vw) : null;
            }
            const box = this.placed(`p-${e.id}`, vw.x, vw.st ? vw.st.glide : (this.stage?.shift ?? CFG.SHIFT_MS), null, false, vw.st?.linear ? "linear" : "ease-in-out");
            const lift = (c) => div().relative().transition("top", { duration: CFG.RISE_UP_MS, easing: "ease-out" }).top(onTrackBox(vw) ? -LANE_UP : 0).child(c);
            if (e.id.startsWith("g:")) {
              const g = e.item.g, here = g.members.filter((m) => !own.has(m.address));
              return here.length ? box.child(lift(this.statusGroup(t, g.st, here))) : null;
            }
            return box.child(lift(this.ghost(t, e.item.v, now, 0)));
          }).filter(Boolean));

    this.seenX = this.nextSeenX;
    return v_flex().id("root").size_full().overflow_hidden().bg("#040a08b8")
      .border_b(1).border_color("#7ddcb466")
      .on_size_change((size, cx) => { if (size.width !== this.width) { this.width = size.width; cx.notify(); } })
      .child(header)
      .child(this.ticker(t, now))
      .child(field);
  }
}

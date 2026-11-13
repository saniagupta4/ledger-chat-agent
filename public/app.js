/* Ledger chat UI — plain JS, no build step. */
const $ = (sel) => document.querySelector(sel);
const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
const MODE_LABEL = { direct: 'Direct answer', search: 'Web search', recall: 'Memory', recall_verify: 'Memory + re-check' };

const state = { threadId: null, busy: false, config: null };

// ---------- markdown (HTML in model output is escaped, never rendered) ----------
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
marked.use({
  gfm: true,
  breaks: false,
  renderer: {
    html: (token) => esc(token.text ?? token.raw ?? ''),
    link: (token) => `<a href="${esc(token.href)}" target="_blank" rel="noopener noreferrer">${token.text}</a>`,
  },
});
function renderMarkdown(text, sources = []) {
  let html = marked.parse(text || '');
  const byN = new Map(sources.map((s) => [s.n, s]));
  // [1], [1][2] and grouped [2, 3] all become clickable citation chips.
  return html.replace(/\[(\d+(?:\s*,\s*\d+)*)\]/g, (m, group) => {
    const parts = group.split(',').map((n) => n.trim());
    if (!parts.every((n) => byN.has(Number(n)))) return m;
    return parts
      .map((n) => { const s = byN.get(Number(n)); return `<a class="cite" href="${esc(s.url)}" target="_blank" rel="noopener" title="${esc(s.title)}">${n}</a>`; })
      .join('');
  });
}

// ---------- agent clock (time travel for testing) ----------
function clockOffset() { return Number(localStorage.getItem('clockOffsetMs') || 0); }
function agentNow() { return new Date(Date.now() + clockOffset()); }
function toLocalInput(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}
function renderClock() {
  const travelling = clockOffset() !== 0;
  $('#clockBox').classList.toggle('travelling', travelling);
  $('#clock').value = toLocalInput(agentNow());
  $('#clockState').textContent = travelling
    ? `Agent thinks it is ${agentNow().toLocaleString([], { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}`
    : 'Live (real time)';
}
$('#clock').addEventListener('change', (e) => {
  const chosen = new Date(e.target.value);
  if (!Number.isNaN(chosen.getTime())) localStorage.setItem('clockOffsetMs', String(chosen.getTime() - Date.now()));
  renderClock();
});
$('#clockLive').addEventListener('click', () => { localStorage.removeItem('clockOffsetMs'); renderClock(); });

// ---------- threads ----------
async function loadThreads() {
  const threads = await fetch('/api/threads').then((r) => r.json());
  $('#threads').innerHTML = threads
    .map((t) => `<a href="#${t.id}" data-id="${t.id}" class="${t.id === state.threadId ? 'active' : ''}">${esc(t.title)}<small>${new Date(t.updatedAt).toLocaleString([], { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}</small></a>`)
    .join('');
}
$('#threads').addEventListener('click', (e) => {
  const a = e.target.closest('a[data-id]');
  if (!a) return;
  e.preventDefault();
  openThread(a.dataset.id);
});
async function openThread(id) {
  if (state.busy) return;
  const data = await fetch(`/api/threads/${id}`).then((r) => r.json());
  state.threadId = id;
  location.hash = id;
  $('#messages').innerHTML = '';
  for (const m of data.messages) {
    if (m.role === 'user') addUser(m.content, m.createdAt);
    else {
      const v = addAssistant();
      v.setMode(m.mode);
      v.finish(m.content, m.sources || [], null, m.createdAt);
    }
  }
  loadThreads();
  scrollDown(true);
}
$('#newChat').addEventListener('click', () => {
  if (state.busy) return;
  state.threadId = null;
  history.replaceState(null, '', location.pathname);
  $('#messages').innerHTML = '';
  $('#messages').appendChild(emptyState);
  loadThreads();
  $('#input').focus();
});

// ---------- messages ----------
const emptyState = $('#empty');
function scrollDown(force) {
  const box = $('#messages');
  if (force || box.scrollHeight - box.scrollTop - box.clientHeight < 160) box.scrollTop = box.scrollHeight;
}
function fmtWhen(iso) {
  return new Date(iso).toLocaleString([], { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}
function addUser(text, at) {
  emptyState.remove();
  const el = document.createElement('div');
  el.className = 'msg user';
  el.innerHTML = `<div class="bubble">${esc(text)}</div><div class="when">${fmtWhen(at)}</div>`;
  $('#messages').appendChild(el);
}
function addAssistant() {
  emptyState.remove();
  const el = document.createElement('div');
  el.className = 'msg assistant';
  el.innerHTML = `<div class="trace"></div><div class="verify-slot"></div><div class="answer cursor"></div><div class="sources"></div><div class="timing"></div>`;
  $('#messages').appendChild(el);
  const trace = el.querySelector('.trace');
  const answer = el.querySelector('.answer');
  let steps = null;
  let text = '';
  let raf = 0;
  return {
    setMode(mode, reason) {
      if (!mode) return;
      const chip = document.createElement('span');
      chip.className = 'chip mode';
      chip.textContent = MODE_LABEL[mode] || mode;
      if (reason) chip.title = reason;
      trace.prepend(chip);
    },
    chip(text) {
      const c = document.createElement('span');
      c.className = 'chip';
      c.textContent = text;
      trace.appendChild(c);
    },
    step(text) {
      if (!steps) { steps = document.createElement('ul'); steps.className = 'steps'; trace.appendChild(steps); }
      steps.querySelectorAll('li.live').forEach((li) => li.classList.remove('live'));
      const li = document.createElement('li');
      li.className = 'live';
      li.textContent = text;
      steps.appendChild(li);
      scrollDown();
    },
    verification(report) {
      const rows = report.checks
        .map((c) => `<tr><td><span class="badge ${c.status}">${c.status === 'unverifiable' ? "can't verify" : c.status}</span></td><td><b>${esc(c.subject)}</b><br><span class="hint">${esc(c.attribute)}</span></td><td>${c.status === 'changed' ? `<s>${esc(c.was)}</s><br>${esc(c.now)}` : esc(c.was)}</td></tr>`)
        .join('');
      const devs = report.developments.map((d) => `<div class="dev">🆕 <b>${esc(d.subject)}</b> — ${esc(d.what)} <span class="hint">(${esc(d.date)})</span></div>`).join('');
      el.querySelector('.verify-slot').innerHTML = `<div class="verify"><div class="head">Re-checked ${report.checks.length} saved fact${report.checks.length === 1 ? '' : 's'} from ${fmtWhen(report.since)}</div><table>${rows}</table>${devs}</div>`;
      scrollDown();
    },
    token(t) {
      text += t;
      if (!raf) raf = requestAnimationFrame(() => { raf = 0; answer.innerHTML = renderMarkdown(text); scrollDown(); });
    },
    error(msg) {
      const e = document.createElement('div');
      e.className = 'error';
      e.textContent = msg;
      el.appendChild(e);
    },
    finish(finalText, sources, timings, at) {
      cancelAnimationFrame(raf);
      text = finalText ?? text;
      answer.classList.remove('cursor');
      answer.innerHTML = renderMarkdown(text, sources);
      steps?.querySelectorAll('li.live').forEach((li) => li.classList.remove('live'));
      if (steps && timings) { const d = document.createElement('details'); d.innerHTML = '<summary>How I got this</summary>'; steps.replaceWith(d); d.appendChild(steps); }
      el.querySelector('.sources').innerHTML = sources
        .map((s) => `<a href="${esc(s.url)}" target="_blank" rel="noopener"><b>[${s.n}]</b>${esc(s.title)} <span class="hint">· ${esc(new URL(s.url).hostname)}</span></a>`)
        .join('');
      const parts = [];
      if (timings?.firstToken) parts.push(`first word ${(timings.firstToken / 1000).toFixed(1)}s`);
      if (timings?.total) parts.push(`done ${(timings.total / 1000).toFixed(1)}s`);
      if (at) parts.push(fmtWhen(at));
      el.querySelector('.timing').textContent = parts.join(' · ');
    },
  };
}

// ---------- send ----------
async function send(message) {
  if (state.busy || !message.trim()) return;
  state.busy = true;
  $('#send').disabled = true;
  const now = agentNow();
  addUser(message, now.toISOString());
  const view = addAssistant();
  scrollDown(true);

  let finalSources = [];
  let timings = null;
  try {
    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ threadId: state.threadId, message, timezone, now: clockOffset() ? now.toISOString() : undefined }),
    });
    if (!res.ok || !res.body) throw new Error((await res.json().catch(() => ({}))).error || `HTTP ${res.status}`);
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const raw = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const dataLine = raw.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trimStart()).join('\n');
        if (!dataLine) continue;
        const ev = JSON.parse(dataLine);
        switch (ev.type) {
          case 'thread': state.threadId = ev.threadId; location.hash = ev.threadId; loadThreads(); break;
          case 'status': view.step(ev.text); break;
          case 'plan':
            view.setMode(ev.mode, ev.reason);
            for (const r of ev.timeRefs) view.chip(`“${r.phrase}” = ${r.label}`);
            for (const r of ev.recalled) view.step(`Recalled: ${r.when} — “${r.question.slice(0, 90)}”`);
            break;
          case 'verification': view.verification(ev.report); break;
          case 'token': view.token(ev.text); break;
          case 'sources': finalSources = ev.sources; break;
          case 'done': timings = ev.timings; break;
          case 'error': view.error(ev.message); break;
        }
      }
    }
  } catch (err) {
    view.error(err.message);
  }
  view.finish(undefined, finalSources, timings || {}, null);
  state.busy = false;
  $('#send').disabled = false;
  loadThreads();
  refreshLedgerCount();
  $('#input').focus();
}

$('#composer').addEventListener('submit', (e) => {
  e.preventDefault();
  const v = $('#input').value;
  $('#input').value = '';
  autosize();
  send(v);
});
$('#input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); $('#composer').requestSubmit(); }
});
function autosize() { const t = $('#input'); t.style.height = 'auto'; t.style.height = `${Math.min(t.scrollHeight, 200)}px`; }
$('#input').addEventListener('input', autosize);
document.querySelectorAll('.examples button').forEach((b) => b.addEventListener('click', () => send(b.textContent)));

// ---------- ledger ----------
async function refreshLedgerCount() {
  const claims = await fetch('/api/ledger').then((r) => r.json());
  $('#ledgerCount').textContent = claims.length || '';
  return claims;
}
$('#openLedger').addEventListener('click', async () => {
  const claims = await refreshLedgerCount();
  $('#ledgerBody').innerHTML = claims.length
    ? `<table><tr><th>Observed</th><th>Fact</th><th>Value</th><th>Status</th></tr>${claims
        .map((c) => `<tr><td>${fmtWhen(c.observedAt)}</td><td><b>${esc(c.subject)}</b><br><span class="hint">${esc(c.attribute)}</span></td><td>${c.status === 'changed' && c.previousValue ? `<s class="hint">${esc(c.previousValue)}</s><br>` : ''}${esc(c.value)}${c.sourceUrl ? `<br><a href="${esc(c.sourceUrl)}" target="_blank" rel="noopener">source</a>` : ''}</td><td>${c.origin === 'reverified' ? `<span class="badge ${c.status}">re-check: ${c.status}</span>` : '<span class="hint">stated</span>'}</td></tr>`)
        .join('')}</table>`
    : '<p class="hint">No facts yet. Ask something that needs a web search.</p>';
  $('#ledger').hidden = false;
});
$('#closeLedger').addEventListener('click', () => ($('#ledger').hidden = true));

// ---------- boot ----------
(async function boot() {
  state.config = await fetch('/api/config').then((r) => r.json());
  const c = state.config;
  const problems = [];
  if (!c.hasLlmKey) problems.push(`Set <code>${c.providerKeyEnv}</code> in <code>.env</code>`);
  if (!c.hasSearchKey) problems.push('Set <code>TAVILY_API_KEY</code> in <code>.env</code> (web search is off)');
  if (problems.length) { $('#banner').innerHTML = `${problems.join(' · ')}, then restart <code>npm run dev</code>.`; $('#banner').hidden = false; }
  $('#modelInfo').textContent = `${c.provider} · ${c.mainModel}`;
  $('#clockBox').hidden = !c.allowTimeTravel;
  renderClock();
  await loadThreads();
  refreshLedgerCount();
  const id = location.hash.slice(1);
  if (id) openThread(id);
  $('#input').focus();
})();

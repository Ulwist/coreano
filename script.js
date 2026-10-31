'use strict';
/* ═══════════════════════════════════════════
   Flashcards de Coreano — repetición espaciada
   Datos: localStorage (mismas claves que la versión anterior)
   ═══════════════════════════════════════════ */

const $ = (id) => document.getElementById(id);
const KEYS = { cards: 'koreanFlashcards', topics: 'flashcardTopics', daily: 'flashcardDailyStats', settings: 'koreanSettings', dark: 'darkMode', syncMeta: 'koreanSyncMeta', pending: 'koreanPendingDel' };

let cards = [];
let topics = [];
let daily = {};
let settings = { newPerDay: 10, maxReviews: 100, auto: false, dir: 'ko', lastExport: null };
let syncMeta = { topicsUpdated: 0, settingsUpdated: 0, topicsJson: '', settingsJson: '', delTopics: {} };
const sync = { user: null, base: '', auth: null, db: null, unsubs: [], lastJson: new Map(), queue: new Map(), pendingDel: {}, timer: null, mTimer: null, applying: false, status: 'off', err: '', metaSeen: false, cardsSeen: false };

/* ───────── utilidades ───────── */
function lsGet(k, fallback) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : fallback; } catch (e) { return fallback; } }
function lsSet(k, v) { try { localStorage.setItem(k, typeof v === 'string' ? v : JSON.stringify(v)); } catch (e) { console.warn('No se pudo guardar', e); } }
const saveCards = () => { syncTrack(); lsSet(KEYS.cards, cards); };
const saveTopics = () => { lsSet(KEYS.topics, topics); topicsTrack(); };
const saveDaily = () => { lsSet(KEYS.daily, daily); pushMetaSoon(); };
const saveSettings = () => { lsSet(KEYS.settings, settings); settingsTrack(); };

function esc(s) { return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
function shuffle(a) { a = [...a]; for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; }
function pad(n) { return String(n).padStart(2, '0'); }
function dayKey(d = new Date()) { return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }
function addDays(key, n) { const [y, m, d] = key.split('-').map(Number); return dayKey(new Date(y, m - 1, d + n)); }
function daysBetween(a, b) { const f = (k) => { const [y, m, d] = k.split('-').map(Number); return Date.UTC(y, m - 1, d); }; return Math.round((f(b) - f(a)) / 86400000); }
const today = () => dayKey();
function toast(msg) { const t = $('toast'); t.textContent = msg; t.classList.add('show'); clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.remove('show'), 2600); }
function topicName(id) { const t = topics.find(t => t.id === id); return t ? t.name : 'Sin carpeta'; }

/* ───────── estado de cada tarjeta ───────── */
const isNew = (c) => !c.firstSeen;
const isDue = (c) => !!c.firstSeen && (c.due || today()) <= today();
const isMastered = (c) => (c.ivl || 0) >= 21;
const isWeak = (c) => (c.lapses || 0) >= 2 && (c.ivl || 0) < 21;

function migrateCards() {
  const map = { dificil: 1, medio: 3, facil: 7 };
  let changed = false;
  cards.forEach(c => {
    if (c.lastSeenLearn && !c.firstSeen) {
      const seen = dayKey(new Date(c.lastSeenLearn));
      const ivl = map[c.difficulty] || 1;
      c.firstSeen = seen; c.ivl = ivl; c.ease = 2.5; c.reps = 1; c.lapses = c.lapses || 0;
      c.due = addDays(seen, ivl);
      changed = true;
    }
  });
  if (changed) saveCards();
}

/* ───────── algoritmo de repaso ───────── */
function computeNext(card, q) {
  let ease = card.ease || 2.5, ivl = card.ivl || 0, reps = card.reps || 0;
  const relearn = !!card.relearn;
  if (q === 'again') return { ivl: 0, ease: Math.max(1.3, ease - 0.2), relearn: true };
  let n;
  if (q === 'good') {
    n = (relearn || reps === 0) ? 1 : Math.max(ivl + 1, Math.round(ivl * ease));
  } else {
    n = relearn ? 2 : reps === 0 ? 4 : Math.max(ivl + 2, Math.round(ivl * ease * 1.3));
    ease = Math.min(3, ease + 0.1);
  }
  return { ivl: Math.min(n, 365), ease, relearn: false };
}
function fmtIv(d) {
  if (d < 1) return 'hoy';
  if (d === 1) return '1 día';
  if (d < 30) return `${d} días`;
  if (d < 365) return `${Math.round(d / 30)} mes${Math.round(d / 30) > 1 ? 'es' : ''}`;
  return '1 año';
}
function applyRating(card, q) {
  const next = computeNext(card, q);
  if (q === 'again' && (card.reps || 0) > 0) card.lapses = (card.lapses || 0) + 1;
  if (q !== 'again') card.reps = (card.reps || 0) + 1;
  card.ease = next.ease; card.ivl = next.ivl; card.relearn = next.relearn;
  card.due = next.ivl === 0 ? today() : addDays(today(), next.ivl);
  if (!card.firstSeen) card.firstSeen = today();
  card.lastSeenLearn = new Date().toISOString();
  card.difficulty = q === 'again' ? 'dificil' : q === 'good' ? 'medio' : 'facil';
  const key = today();
  if (!daily[key]) daily[key] = { dificil: 0, medio: 0, facil: 0 };
  daily[key][card.difficulty]++;
  saveCards(); saveDaily();
}

/* ───────── voz (TTS) ───────── */
function koVoice() {
  if (!window.speechSynthesis) return null;
  const v = speechSynthesis.getVoices().filter(v => v.lang && v.lang.toLowerCase().startsWith('ko'));
  const pref = ['Google', 'Microsoft', 'Yuna', 'Sun-Hi'];
  for (const p of pref) { const f = v.find(x => x.name.includes(p)); if (f) return f; }
  return v[0] || null;
}
function speak(text, btn) {
  if (!text || !window.speechSynthesis) { toast('Tu navegador no tiene voz.'); return; }
  speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text);
  u.lang = 'ko-KR'; u.rate = 0.85;
  const v = koVoice(); if (v) u.voice = v;
  if (btn) { btn.classList.add('playing'); const off = () => btn.classList.remove('playing'); u.onend = off; u.onerror = off; }
  speechSynthesis.speak(u);
}
function updateTtsInfo() {
  const el = $('ttsInfo'); if (!el) return;
  if (!window.speechSynthesis) { el.textContent = 'Este navegador no soporta voz.'; return; }
  const v = koVoice();
  el.textContent = v ? `Voz coreana: ${v.name}` : 'No hay voz coreana instalada en este dispositivo (instálala en los ajustes de idioma del sistema).';
}
if (window.speechSynthesis) { speechSynthesis.getVoices(); speechSynthesis.onvoiceschanged = updateTtsInfo; }

/* ───────── navegación ───────── */
let currentView = 'home';
function show(view) {
  currentView = view;
  document.querySelectorAll('.view').forEach(v => v.style.display = 'none');
  $('view-' + view).style.display = 'block';
  document.querySelectorAll('#tabs button').forEach(b => b.classList.toggle('active', b.dataset.view === view));
  window.scrollTo(0, 0);
  if (view === 'home') renderHome();
  if (view === 'learn') enterLearn();
  if (view === 'practice') enterPractice();
  if (view === 'cards') renderCards(true);
  if (view === 'folders') renderFolders();
  if (view === 'progress') renderProgress();
  if (view === 'settings') renderSettings();
}
$('tabs').addEventListener('click', e => { const b = e.target.closest('button'); if (b) show(b.dataset.view); });

function toggleDark() {
  const d = document.body.classList.toggle('dark');
  $('darkBtn').textContent = d ? '☀️' : '🌙';
  lsSet(KEYS.dark, d ? '1' : '0');
}
$('darkBtn').addEventListener('click', toggleDark);

/* ───────── selects de carpeta ───────── */
function folderOptions(withAll = true, selected) {
  let h = withAll ? '<option value="__all__">📚 Todas las carpetas</option>' : '';
  topics.forEach(t => { h += `<option value="${esc(t.id)}">${esc(t.name)} (${cards.filter(c => c.topicId === t.id).length})</option>`; });
  if (cards.some(c => !c.topicId)) h += `<option value="__none__">📂 Sin carpeta (${cards.filter(c => !c.topicId).length})</option>`;
  return h;
}
function fillSelect(id, withAll = true, keep = true) {
  const el = $(id); if (!el) return;
  const prev = el.value;
  el.innerHTML = folderOptions(withAll);
  if (keep && [...el.options].some(o => o.value === prev)) el.value = prev;
}
function fillAllSelects() {
  ['learnFolder', 'pFolder', 'cardsFolder'].forEach(id => fillSelect(id));
  const el = $('addTopic'); const prev = el.value;
  el.innerHTML = '<option value="">— Sin carpeta —</option>' + topics.map(t => `<option value="${esc(t.id)}">${esc(t.name)}</option>`).join('');
  if ([...el.options].some(o => o.value === prev)) el.value = prev;
}
function poolFor(folder) {
  if (!folder || folder === '__all__') return cards;
  if (folder === '__none__') return cards.filter(c => !c.topicId);
  return cards.filter(c => c.topicId === folder);
}

/* ═══════════ INICIO ═══════════ */
function streakDays() {
  let n = 0; let k = today();
  const has = (key) => { const s = daily[key]; return s && (s.dificil || s.medio || s.facil); };
  if (!has(k)) k = addDays(k, -1);
  while (has(k)) { n++; k = addDays(k, -1); }
  return n;
}
function todayDone() { const s = daily[today()]; return s ? (s.dificil || 0) + (s.medio || 0) + (s.facil || 0) : 0; }
function introducedToday() { return cards.filter(c => c.firstSeen === today()).length; }
function queueCounts(pool = cards) {
  const due = pool.filter(isDue).length;
  const allowedNew = Math.max(0, settings.newPerDay - introducedToday());
  const nw = Math.min(allowedNew, pool.filter(isNew).length);
  return { due: Math.min(due, settings.maxReviews), nw };
}

function renderHome() {
  const empty = cards.length === 0;
  $('onboarding').style.display = empty ? 'block' : 'none';
  $('homeMain').style.display = empty ? 'none' : 'block';
  if (empty) return;
  $('homeDate').textContent = new Date().toLocaleDateString('es-AR', { weekday: 'long', day: 'numeric', month: 'long' });
  const q = queueCounts();
  $('qDue').textContent = q.due; $('qNew').textContent = q.nw; $('qDone').textContent = todayDone();
  $('homeStreak').textContent = '🔥 ' + streakDays();
  const total = q.due + q.nw;
  $('startDaily').disabled = false;
  $('startDaily').textContent = total ? `▶ Empezar repaso (${total})` : '▶ Repasar de todos modos';
  $('homeTitle').textContent = total ? 'Tu repaso de hoy' : '¡Estás al día! 🎉';
  $('homeHint').textContent = total ? `Aproximadamente ${Math.max(1, Math.round(total * 8 / 60))} minutos. Hazlo todos los días: la constancia vale más que las sesiones largas.` : 'No quedan repasos ni palabras nuevas por hoy. Puedes practicar para reforzar.';

  const nNew = cards.filter(isNew).length, nMas = cards.filter(c => c.firstSeen && isMastered(c)).length, nLearn = cards.length - nNew - nMas;
  const pc = (n) => (n / cards.length * 100).toFixed(1);
  $('stackBar').innerHTML = `<i class="c-m" style="width:${pc(nMas)}%"></i><i class="c-l" style="width:${pc(nLearn)}%"></i>`;
  $('stackLegend').innerHTML = `<span><i class="dot c-m"></i>Dominadas ${nMas}</span><span><i class="dot c-l"></i>Aprendiendo ${nLearn}</span><span><i class="dot c-n"></i>Sin ver ${nNew}</span>`;

  const weak = cards.filter(isWeak).sort((a, b) => (b.lapses || 0) - (a.lapses || 0)).slice(0, 12);
  $('weakList').innerHTML = weak.length ? weak.map(c => `<span class="weak-chip" title="${esc(c.spanish)}">${esc(c.korean)}</span>`).join('') : '<span class="muted">Todavía no hay palabras difíciles. ¡Bien!</span>';
  $('practiceWeak').style.display = weak.length ? '' : 'none';

  $('folderMastery').innerHTML = topics.map(t => {
    const list = cards.filter(c => c.topicId === t.id); if (!list.length) return '';
    const m = list.filter(c => c.firstSeen && isMastered(c)).length, l = list.filter(c => c.firstSeen && !isMastered(c)).length;
    return `<div class="mastery-row"><span>${esc(t.name)}</span><div class="mini-bar"><i class="seg-m" style="width:${m / list.length * 100}%"></i><i class="seg-l" style="width:${l / list.length * 100}%"></i></div><span>${m}/${list.length}</span></div>`;
  }).join('');

  renderSyncUi();
  const w = $('backupWarn');
  const days = settings.lastExport ? daysBetween(dayKey(new Date(settings.lastExport)), today()) : null;
  if (days === null || days >= 7) {
    w.style.display = 'block';
    w.innerHTML = `💾 ${days === null ? 'Todavía no hiciste ninguna copia de seguridad.' : `Hace ${days} días que no exportas tus tarjetas.`} <button class="btn small" id="warnExport">Exportar ahora</button>`;
    $('warnExport').onclick = exportData;
  } else w.style.display = 'none';
}
$('startDaily').addEventListener('click', () => { learn.folder = '__all__'; learn.session = null; $('learnFolder').value = '__all__'; show('learn'); });
$('startPracticeHome').addEventListener('click', () => show('practice'));
$('practiceWeak').addEventListener('click', () => { show('practice'); $('pWeak').checked = true; startPractice(); });

/* ═══════════ APRENDER ═══════════ */
const learn = { session: null, folder: '__all__', extraNew: 0, cram: false };

function buildQueue(pool, extraNew = 0) {
  const due = shuffle(pool.filter(isDue).sort((a, b) => (a.due || '').localeCompare(b.due || '')).slice(0, settings.maxReviews).reverse().reverse());
  const dueSorted = pool.filter(isDue).sort((a, b) => (a.due || '').localeCompare(b.due || '')).slice(0, settings.maxReviews);
  const allowed = Math.max(0, settings.newPerDay - introducedToday()) + extraNew;
  const fresh = pool.filter(isNew).slice(0, allowed);
  return [...shuffle(dueSorted), ...fresh];
}
function enterLearn() {
  fillAllSelects();
  $('learnFolder').value = learn.folder;
  $('learnDir').value = settings.dir;
  if (!learn.session) startLearn();
  else renderLearn();
}
function startLearn(opts = {}) {
  const pool = poolFor(learn.folder);
  if (!pool.length) { $('learnArea').style.display = 'none'; $('learnDone').style.display = 'block'; $('learnDoneTitle').textContent = 'No hay tarjetas aquí'; $('learnDoneText').textContent = 'Importa tarjetas o elige otra carpeta.'; $('learnMoreNew').style.display = 'none'; $('learnAll').style.display = 'none'; return; }
  learn.cram = !!opts.cram;
  const queue = opts.cram ? shuffle(pool) : buildQueue(pool, learn.extraNew);
  learn.session = { queue, index: 0, done: 0, total: queue.length, revealed: false, stats: { again: 0, good: 0, easy: 0 } };
  renderLearn();
}
function renderLearn() {
  const s = learn.session;
  $('learnMoreNew').style.display = ''; $('learnAll').style.display = '';
  if (!s || s.index >= s.queue.length) {
    $('learnArea').style.display = 'none'; $('learnDone').style.display = 'block';
    const st = s ? s.stats : { again: 0, good: 0, easy: 0 };
    const none = !s || s.total === 0;
    $('learnDoneTitle').textContent = none ? '¡Estás al día! 🎉' : '¡Sesión completada! 🎉';
    $('learnDoneText').textContent = none ? 'No hay repasos ni palabras nuevas pendientes por hoy.' : `Repasaste ${s.total} tarjetas · Otra vez ${st.again} · Bien ${st.good} · Fácil ${st.easy}`;
    $('learnBar').style.width = '100%';
    return;
  }
  $('learnArea').style.display = 'block'; $('learnDone').style.display = 'none';
  const card = s.queue[s.index];
  const ko = settings.dir === 'ko';
  const wasRevealed = $('learnCard').classList.contains('revealed');
  s.revealed = false;
  $('learnCard').classList.remove('revealed');
  $('learnLabelFront').textContent = ko ? 'Coreano' : 'Español';
  const front = $('learnFront'); front.textContent = ko ? card.korean : card.spanish; front.classList.toggle('es', !ko);
  $('learnAudio').style.display = ko ? '' : 'none';
  // El dorso se rellena recién cuando la tarjeta terminó de darse vuelta,
  // para que no se alcance a ver la respuesta siguiente durante la animación.
  clearTimeout(learn.backTimer);
  learn.fillBack = () => {
    clearTimeout(learn.backTimer); learn.fillBack = null;
    $('learnLabelBack').textContent = ko ? 'Español' : 'Coreano';
    $('learnBack').textContent = ko ? card.spanish : card.korean;
    $('learnBack').style.fontFamily = ko ? '' : 'var(--ko)';
    $('learnBackSub').innerHTML = ko ? `<span class="ko-sub" style="font-family:var(--ko);font-size:22px">${esc(card.korean)}</span>` : '<button class="btn-audio" id="learnAudio2">🔊</button>';
    if (!ko) $('learnAudio2').onclick = (e) => { e.stopPropagation(); speak(card.korean, e.currentTarget); };
    $('learnExample').innerHTML = card.example ? `<b>${esc(card.example.split('=')[0].trim())}</b>${card.example.includes('=') ? '<br>' + esc(card.example.split('=').slice(1).join('=').trim()) : ''}` : '';
  };
  if (wasRevealed) learn.backTimer = setTimeout(() => learn.fillBack && learn.fillBack(), 520);
  else learn.fillBack();
  $('learnRate').style.visibility = 'hidden';
  const nw = s.queue.filter(isNew).length;
  $('learnInfo').textContent = `${s.queue.length - s.index} por hacer${learn.cram ? ' · modo repaso libre (no cambia fechas)' : ''}`;
  $('learnBar').style.width = (s.total ? s.done / s.total * 100 : 0) + '%';
  if (ko && settings.auto) speak(card.korean, $('learnAudio'));
}
function revealLearn() {
  const s = learn.session; if (!s || s.revealed || s.index >= s.queue.length) return;
  s.revealed = true;
  if (learn.fillBack) learn.fillBack();
  $('learnCard').classList.add('revealed');
  const card = s.queue[s.index];
  $('ivAgain').textContent = 'hoy'; $('ivGood').textContent = fmtIv(computeNext(card, 'good').ivl); $('ivEasy').textContent = fmtIv(computeNext(card, 'easy').ivl);
  $('learnRate').style.visibility = 'visible';
  if (settings.dir === 'es' && settings.auto) speak(card.korean);
}
function rateLearn(q) {
  const s = learn.session; if (!s || !s.revealed) return;
  const card = s.queue[s.index];
  s.stats[q]++;
  if (!learn.cram) applyRating(card, q);
  s.index++;
  if (q === 'again') s.queue.splice(Math.min(s.index + 3, s.queue.length), 0, card);
  else s.done++;
  renderLearn();
}
$('learnCard').addEventListener('click', revealLearn);
$('learnAudio').addEventListener('click', e => { e.stopPropagation(); const s = learn.session; if (s) speak(s.queue[s.index].korean, e.currentTarget); });
$('learnRate').addEventListener('click', e => { const b = e.target.closest('[data-rate]'); if (b) rateLearn(b.dataset.rate); });
$('learnFolder').addEventListener('change', () => { learn.folder = $('learnFolder').value; learn.extraNew = 0; startLearn(); });
$('learnDir').addEventListener('change', () => { settings.dir = $('learnDir').value; saveSettings(); renderLearn(); });
$('learnMoreNew').addEventListener('click', () => { learn.extraNew += 10; startLearn(); });
$('learnAll').addEventListener('click', () => startLearn({ cram: true }));

/* ═══════════ PRACTICAR ═══════════ */
let prac = null;
function enterPractice() {
  fillAllSelects();
  if (!prac) { $('practiceSetup').style.display = 'block'; $('practiceRun').style.display = 'none'; $('practiceDone').style.display = 'none'; }
}
function normText(s) {
  return String(s).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\([^)]*\)/g, ' ').replace(/[¿?¡!.,;:"'“”]/g, ' ').replace(/\s+/g, ' ').trim();
}
function stripArticle(s) { return s.replace(/^(el|la|los|las|un|una|unos|unas)\s+/, ''); }
function lev(a, b) {
  const m = a.length, n = b.length; if (!m) return n; if (!n) return m;
  let prev = Array.from({ length: n + 1 }, (_, i) => i);
  for (let i = 1; i <= m; i++) { const cur = [i]; for (let j = 1; j <= n; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)); prev = cur; }
  return prev[n];
}
function checkSpanish(input, expected) {
  const u = stripArticle(normText(input)); if (!u) return 'empty';
  const full = normText(expected);
  const alts = new Set([full, stripArticle(full)]);
  expected.split(/[\/;,]|\s+o\s+/).forEach(a => { const n = normText(a); if (n) { alts.add(n); alts.add(stripArticle(n)); } });
  const clean = [...alts].filter(Boolean);
  if (clean.includes(u)) return 'ok';
  if (u.length >= 5 && clean.some(a => lev(a, u) <= 1)) return 'near';
  return 'bad';
}
function checkKorean(input, expected) {
  const f = (s) => String(s).normalize('NFC').replace(/[\s?!.,~]/g, '');
  return f(input) && f(input) === f(expected) ? 'ok' : 'bad';
}

function startPractice(customPool) {
  let pool = customPool || poolFor($('pFolder').value);
  if ($('pWeak').checked && !customPool) pool = pool.filter(c => (c.lapses || 0) >= 1 && (c.ivl || 0) < 21);
  if (pool.length < 1) { toast('No hay tarjetas para esa selección.'); return; }
  const mode = $('pMode').value;
  if (mode.startsWith('mc') && cards.length < 4) { toast('Necesitas al menos 4 tarjetas para opción múltiple.'); return; }
  const n = Math.min(parseInt($('pCount').value, 10), pool.length);
  prac = { mode, list: shuffle(pool).slice(0, n), i: 0, ok: 0, bad: 0, wrong: [], answered: false, pool };
  $('practiceSetup').style.display = 'none'; $('practiceDone').style.display = 'none'; $('practiceRun').style.display = 'block';
  renderQuestion();
}
function renderQuestion() {
  const p = prac;
  if (p.i >= p.list.length) return finishPractice();
  p.answered = false;
  const card = p.list[p.i];
  const toKo = p.mode === 'mc-es' || p.mode === 'type-ko';
  $('pBar').style.width = (p.i / p.list.length * 100) + '%';
  $('pPos').textContent = `${p.i + 1} / ${p.list.length}`;
  $('pOk').textContent = '✓ ' + p.ok; $('pBad').textContent = '✗ ' + p.bad;
  $('pLabel').textContent = toKo ? 'Español → 한국어' : '한국어 → Español';
  const pr = $('pPrompt'); pr.textContent = toKo ? card.spanish : card.korean; pr.classList.toggle('es', toKo);
  $('pAudio').style.display = toKo ? 'none' : '';
  $('pFeedback').textContent = ''; $('pFeedback').className = 'feedback';
  $('pNext').style.display = 'none';
  const mc = p.mode.startsWith('mc');
  $('pChoices').style.display = mc ? 'grid' : 'none'; $('pTypeWrap').style.display = mc ? 'none' : 'block';
  if (mc) {
    const correct = toKo ? card.korean : card.spanish;
    const key = (c) => normText(toKo ? c.korean : c.spanish);
    const same = shuffle(cards.filter(c => c.id !== card.id && c.topicId === card.topicId && key(c) !== key(card)));
    const rest = shuffle(cards.filter(c => c.id !== card.id && c.topicId !== card.topicId && key(c) !== key(card)));
    const seen = new Set([key(card)]); const opts = [];
    for (const c of [...same, ...rest]) { if (opts.length >= 3) break; if (!seen.has(key(c))) { seen.add(key(c)); opts.push(toKo ? c.korean : c.spanish); } }
    const all = shuffle([correct, ...opts]);
    $('pChoices').innerHTML = all.map((t, i) => `<button class="choice ${toKo ? 'ko' : ''}" data-v="${esc(t)}"><kbd>${i + 1}</kbd><span>${esc(t)}</span></button>`).join('');
    p.correct = correct;
  } else { const inp = $('pInput'); inp.value = ''; inp.disabled = false; inp.focus(); $('pCheck').style.display = ''; $('pSkip').style.display = ''; }
  if (!toKo && settings.auto) speak(card.korean, $('pAudio'));
}
function answerPractice(result, shown) {
  const p = prac; if (p.answered) return; p.answered = true;
  const card = p.list[p.i];
  const fb = $('pFeedback');
  const toKo = p.mode === 'mc-es' || p.mode === 'type-ko';
  const expected = toKo ? card.korean : card.spanish;
  if (result === 'ok' || result === 'near') {
    p.ok++;
    fb.textContent = result === 'near' ? `✓ Casi: la forma exacta es «${expected}»` : '✓ ¡Correcto!'; fb.className = 'feedback ok';
    if (toKo) speak(card.korean);
    setTimeout(() => { if (prac === p && p.answered && p.list[p.i] === card) { p.i++; renderQuestion(); } }, result === 'near' ? 1500 : 700);
  } else {
    p.bad++; p.wrong.push(card);
    card.lapses = (card.lapses || 0) + 1;
    if (card.firstSeen) { card.due = today(); card.ease = Math.max(1.3, (card.ease || 2.5) - 0.1); }
    saveCards();
    fb.textContent = `✗ Respuesta correcta: ${expected}`; fb.className = 'feedback bad';
    speak(card.korean);
    $('pNext').style.display = ''; $('pNext').focus();
  }
  $('pOk').textContent = '✓ ' + p.ok; $('pBad').textContent = '✗ ' + p.bad;
  document.querySelectorAll('#pChoices .choice').forEach(b => { b.disabled = true; if (b.dataset.v === p.correct) b.classList.add('right'); else if (b.dataset.v === shown) b.classList.add('wrong'); });
  $('pInput').disabled = true; $('pCheck').style.display = 'none'; $('pSkip').style.display = 'none';
}
function finishPractice() {
  const p = prac; $('practiceRun').style.display = 'none'; $('practiceDone').style.display = 'block';
  const pct = Math.round(p.ok / p.list.length * 100);
  $('pDoneTitle').textContent = pct === 100 ? '¡Perfecto! 완벽해요! 🌟' : pct >= 80 ? '¡Excelente! 잘했어요! 👏' : pct >= 60 ? '¡Buen intento! 화이팅! 💪' : 'Sigue practicando 연습이 필요해요 📚';
  $('pDoneText').textContent = `${p.ok} de ${p.list.length} correctas (${pct}%). ${p.wrong.length ? 'Las falladas quedaron marcadas para repasarse antes.' : ''}`;
  $('pRetryWrong').style.display = p.wrong.length ? '' : 'none';
}
$('pStart').addEventListener('click', () => startPractice());
$('pBack').addEventListener('click', () => { prac = null; enterPractice(); $('practiceDone').style.display = 'none'; $('practiceSetup').style.display = 'block'; });
$('pRetryWrong').addEventListener('click', () => { const w = prac.wrong, mode = prac.mode; prac = { mode, list: shuffle(w), i: 0, ok: 0, bad: 0, wrong: [], answered: false }; $('practiceDone').style.display = 'none'; $('practiceRun').style.display = 'block'; renderQuestion(); });
$('pChoices').addEventListener('click', e => { const b = e.target.closest('.choice'); if (!b || !prac) return; answerPractice(b.dataset.v === prac.correct ? 'ok' : 'bad', b.dataset.v); });
$('pNext').addEventListener('click', () => { prac.i++; renderQuestion(); });
$('pAudio').addEventListener('click', e => speak(prac.list[prac.i].korean, e.currentTarget));
function submitTyped() {
  const p = prac; if (!p || p.answered) return;
  const card = p.list[p.i]; const v = $('pInput').value;
  const r = p.mode === 'type-ko' ? checkKorean(v, card.korean) : checkSpanish(v, card.spanish);
  if (r === 'empty') return;
  answerPractice(r, v);
}
$('pCheck').addEventListener('click', submitTyped);
$('pSkip').addEventListener('click', () => answerPractice('bad', ''));
$('pInput').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); submitTyped(); } });

/* ═══════════ TARJETAS ═══════════ */
let cardsShown = 60;
function statusChip(c) {
  if (isNew(c)) return '<span class="chip new">nueva</span>';
  if (isWeak(c)) return '<span class="chip weak">difícil</span>';
  if (isMastered(c)) return '<span class="chip mastered">dominada</span>';
  return `<span class="chip">${isDue(c) ? 'repasar hoy' : 'en ' + fmtIv(Math.max(1, daysBetween(today(), c.due || today())))}</span>`;
}
function hl(text, q) {
  const e = esc(text); if (!q) return e;
  const re = new RegExp(esc(q).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
  return e.replace(re, m => `<span class="highlight">${m}</span>`);
}
function renderCards(reset) {
  if (reset) cardsShown = 60;
  fillAllSelects();
  const q = $('search').value.trim().toLowerCase();
  let list = poolFor($('cardsFolder').value);
  const f = $('cardsFilter').value;
  if (f === 'new') list = list.filter(isNew);
  else if (f === 'due') list = list.filter(isDue);
  else if (f === 'weak') list = list.filter(isWeak);
  else if (f === 'mastered') list = list.filter(c => c.firstSeen && isMastered(c));
  if (q) list = list.filter(c => c.korean.toLowerCase().includes(q) || c.spanish.toLowerCase().includes(q));
  $('cardsCount').textContent = `${list.length} tarjeta${list.length !== 1 ? 's' : ''}`;
  const shown = list.slice(0, cardsShown);
  $('cardsList').innerHTML = shown.length ? shown.map(c => `
    <div class="card-row" data-id="${c.id}">
      <div class="ko">${hl(c.korean, q)}</div>
      <div class="es">${hl(c.spanish, q)}${c.example ? `<div class="muted small">${esc(c.example)}</div>` : ''}</div>
      <span class="chip">${esc(topicName(c.topicId))}</span>${statusChip(c)}
      <div class="row-actions"><button data-act="audio" title="Escuchar">🔊</button><button data-act="edit" title="Editar">✏️</button><button data-act="del" title="Eliminar">🗑️</button></div>
    </div>`).join('') : '<p class="muted">No se encontraron tarjetas.</p>';
  $('moreCards').style.display = list.length > cardsShown ? '' : 'none';
}
$('moreCards').addEventListener('click', () => { cardsShown += 60; renderCards(); });
['search', 'cardsFolder', 'cardsFilter'].forEach(id => $(id).addEventListener(id === 'search' ? 'input' : 'change', () => renderCards(true)));
$('cardsList').addEventListener('click', e => {
  const b = e.target.closest('button[data-act]'); if (!b) return;
  const id = Number(b.closest('.card-row').dataset.id); const c = cards.find(x => x.id === id); if (!c) return;
  if (b.dataset.act === 'audio') speak(c.korean, b);
  if (b.dataset.act === 'edit') editCardModal(c);
  if (b.dataset.act === 'del') confirmModal(`¿Eliminar «${c.korean}»?`, 'Esta acción no se puede deshacer.', () => { cards = cards.filter(x => x.id !== id); saveCards(); renderCards(); toast('Tarjeta eliminada'); });
});
$('addBtn').addEventListener('click', () => {
  const ko = $('addKo').value.trim(), es = $('addEs').value.trim();
  if (!ko || !es) { toast('Completa el coreano y el significado.'); return; }
  const dup = cards.find(c => c.korean.replace(/\s/g, '') === ko.replace(/\s/g, '') && c.spanish.toLowerCase() === es.toLowerCase());
  if (dup) { toast('Esa tarjeta ya existe.'); return; }
  const card = { id: Date.now(), korean: ko, spanish: es, topicId: $('addTopic').value || null, created: new Date().toISOString() };
  const ex = $('addExample').value.trim(); if (ex) card.example = ex;
  cards.push(card); saveCards();
  $('addKo').value = ''; $('addEs').value = ''; $('addExample').value = ''; $('addKo').focus();
  renderCards(true); toast('Tarjeta agregada');
});
['addKo', 'addEs', 'addExample'].forEach(id => $(id).addEventListener('keydown', e => { if (e.key === 'Enter') $('addBtn').click(); }));

/* ═══════════ CARPETAS ═══════════ */
function renderFolders() {
  const list = topics.map(t => ({ t, items: cards.filter(c => c.topicId === t.id) }));
  const none = cards.filter(c => !c.topicId);
  const html = (id, name, items, tools) => {
    const m = items.filter(c => c.firstSeen && isMastered(c)).length, l = items.filter(c => c.firstSeen && !isMastered(c)).length;
    const nw = items.filter(isNew).length;
    return `<div class="folder" data-id="${esc(id)}">
      ${tools ? `<div class="folder-tools"><button data-act="rename" title="Renombrar">✏️</button><button data-act="delete" title="Eliminar">✕</button></div>` : ''}
      <h4>📁 ${esc(name)}</h4><div class="count">${items.length} tarjetas · ${nw} nuevas</div>
      <div class="mini-bar"><i class="seg-m" style="width:${items.length ? m / items.length * 100 : 0}%"></i><i class="seg-l" style="width:${items.length ? l / items.length * 100 : 0}%"></i></div>
      <div class="folder-actions"><button class="btn small primary" data-act="learn">Aprender</button><button class="btn small" data-act="practice">Practicar</button><button class="btn small ghost" data-act="open">Ver</button></div></div>`;
  };
  $('folderGrid').innerHTML = list.map(x => html(x.t.id, x.t.name, x.items, true)).join('') + (none.length ? html('__none__', 'Sin carpeta', none, false) : '');
}
$('folderGrid').addEventListener('click', e => {
  const b = e.target.closest('button[data-act]'); const f = e.target.closest('.folder'); if (!f) return;
  const id = f.dataset.id; const act = b ? b.dataset.act : 'open';
  if (act === 'learn') { learn.folder = id; learn.session = null; learn.extraNew = 0; show('learn'); }
  else if (act === 'practice') { show('practice'); $('pFolder').value = id; }
  else if (act === 'open') { show('cards'); $('cardsFolder').value = id; renderCards(true); }
  else if (act === 'rename') { const t = topics.find(t => t.id === id); inputModal('Renombrar carpeta', t.name, (v) => { t.name = v; saveTopics(); renderFolders(); }); }
  else if (act === 'delete') { const t = topics.find(t => t.id === id); confirmModal(`¿Eliminar la carpeta «${t.name}»?`, 'Sus tarjetas quedarán sin carpeta.', () => { topics = topics.filter(x => x.id !== id); cards.forEach(c => { if (c.topicId === id) c.topicId = null; }); saveTopics(); saveCards(); renderFolders(); }); }
});
$('newFolderBtn').addEventListener('click', () => {
  const name = $('newFolderName').value.trim(); if (!name) return;
  if (topics.some(t => t.name.toLowerCase() === name.toLowerCase())) { toast('Ya existe una carpeta con ese nombre.'); return; }
  topics.push({ id: 'topic_' + Date.now(), name }); saveTopics(); $('newFolderName').value = ''; renderFolders();
});

/* ═══════════ PROGRESO ═══════════ */
function renderProgress() {
  const entries = Object.keys(daily).sort().map(k => ({ k, d: daily[k].dificil || 0, m: daily[k].medio || 0, f: daily[k].facil || 0 })).filter(e => e.d + e.m + e.f > 0);
  const totalAll = entries.reduce((s, e) => s + e.d + e.m + e.f, 0);
  const t = daily[today()] || {};
  $('progressSummary').innerHTML = [
    [(t.dificil || 0) + (t.medio || 0) + (t.facil || 0), 'Hoy'], ['🔥 ' + streakDays(), 'Racha (días)'], [totalAll, 'Repasos totales'],
    [cards.filter(c => c.firstSeen && isMastered(c)).length, 'Dominadas'], [cards.filter(c => c.firstSeen && !isMastered(c)).length, 'Aprendiendo'], [cards.filter(isNew).length, 'Sin ver']
  ].map(([v, l]) => `<div class="summary-card"><b>${v}</b><span>${l}</span></div>`).join('');

  const days = []; for (let i = 13; i >= 0; i--) { const k = addDays(today(), -i); const s = daily[k] || {}; days.push({ k, d: s.dificil || 0, m: s.medio || 0, f: s.facil || 0 }); }
  const max = Math.max(1, ...days.map(x => x.d + x.m + x.f));
  const W = 640, H = 190, pl = 28, pb = 22, pt = 12, ch = H - pb - pt, step = (W - pl) / 14, bw = Math.min(30, step - 8);
  let svg = `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">`;
  days.forEach((x, i) => {
    const bx = pl + i * step + (step - bw) / 2; let y = pt + ch;
    [[x.f, '--ok'], [x.m, '--primary'], [x.d, '--bad']].forEach(([v, c]) => { if (v > 0) { const h = v / max * ch; y -= h; svg += `<rect x="${bx}" y="${y}" width="${bw}" height="${h}" rx="3" style="fill:var(${c})"><title>${x.k}: ${v}</title></rect>`; } });
    const tot = x.d + x.m + x.f; if (tot) svg += `<text x="${bx + bw / 2}" y="${y - 4}" text-anchor="middle">${tot}</text>`;
    svg += `<text x="${bx + bw / 2}" y="${H - 6}" text-anchor="middle">${x.k.slice(8)}/${x.k.slice(5, 7)}</text>`;
  });
  $('chart').innerHTML = svg + '</svg>';

  const fc = []; for (let i = 0; i < 14; i++) { const k = addDays(today(), i); fc.push({ k, n: cards.filter(c => c.firstSeen && (i === 0 ? (c.due || today()) <= k : c.due === k)).length }); }
  const fm = Math.max(1, ...fc.map(x => x.n));
  let s2 = `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">`;
  fc.forEach((x, i) => { const bx = pl + i * step + (step - bw) / 2; const h = x.n / fm * ch; s2 += `<rect x="${bx}" y="${pt + ch - h}" width="${bw}" height="${h}" rx="3" style="fill:var(--primary)"><title>${x.k}: ${x.n}</title></rect>`; if (x.n) s2 += `<text x="${bx + bw / 2}" y="${pt + ch - h - 4}" text-anchor="middle">${x.n}</text>`; s2 += `<text x="${bx + bw / 2}" y="${H - 6}" text-anchor="middle">${i === 0 ? 'hoy' : x.k.slice(8) + '/' + x.k.slice(5, 7)}</text>`; });
  $('forecast').innerHTML = s2 + '</svg>';
}

/* ═══════════ AJUSTES + IMPORT/EXPORT ═══════════ */
function renderSettings() {
  $('setNew').value = settings.newPerDay; $('setRev').value = settings.maxReviews; $('setAuto').checked = settings.auto;
  $('lastExport').textContent = settings.lastExport ? 'Última exportación: ' + new Date(settings.lastExport).toLocaleString('es-AR') : 'Todavía no exportaste.';
  updateTtsInfo(); renderSyncUi();
}
$('setNew').addEventListener('change', () => { settings.newPerDay = Math.max(0, parseInt($('setNew').value, 10) || 0); saveSettings(); });
$('setRev').addEventListener('change', () => { settings.maxReviews = Math.max(5, parseInt($('setRev').value, 10) || 100); saveSettings(); });
$('setAuto').addEventListener('change', () => { settings.auto = $('setAuto').checked; saveSettings(); });
$('resetProgress').addEventListener('click', () => confirmModal('¿Reiniciar el progreso?', 'Todas las tarjetas vuelven a "nuevas" y se borra el historial diario. Las tarjetas no se eliminan.', () => {
  cards.forEach(c => { ['firstSeen', 'due', 'ivl', 'ease', 'reps', 'lapses', 'relearn', 'lastSeenLearn', 'difficulty'].forEach(k => delete c[k]); });
  daily = {}; saveCards(); saveDaily(); learn.session = null; toast('Progreso reiniciado');
}));

function exportData() {
  if (!cards.length) { toast('No hay tarjetas para exportar.'); return; }
  const data = { exportDate: new Date().toISOString(), totalCards: cards.length, topics, flashcards: cards, dailyStats: daily, settings };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `flashcards-coreano-${today()}.json`;
  document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(a.href);
  settings.lastExport = new Date().toISOString(); saveSettings(); toast('Exportado ✔'); if (currentView === 'settings') renderSettings(); if (currentView === 'home') renderHome();
}
$('exportBtn').addEventListener('click', exportData);

const PROGRESS_FIELDS = ['firstSeen', 'due', 'ivl', 'ease', 'reps', 'lapses', 'relearn', 'lastSeenLearn', 'difficulty'];
function mergeImport(data) {
  const inCards = Array.isArray(data) ? data : data.flashcards || [];
  const inTopics = Array.isArray(data) ? [] : data.topics || [];
  let added = 0, updated = 0;
  inTopics.forEach(t => { const ex = topics.find(x => x.id === t.id); if (ex) ex.name = t.name; else topics.push(t); });
  const byId = new Map(cards.map(c => [c.id, c]));
  const norm = (c) => c.korean.replace(/\s/g, '') + '|' + c.spanish.toLowerCase();
  const byText = new Set(cards.map(norm));
  inCards.forEach(ic => {
    if (!ic || !ic.korean || !ic.spanish) return;
    const ex = byId.get(ic.id);
    if (ex) {
      ex.korean = ic.korean; ex.spanish = ic.spanish; ex.topicId = ic.topicId ?? ex.topicId; if (ic.example) ex.example = ic.example;
      if (!ex.firstSeen) PROGRESS_FIELDS.forEach(k => { if (ic[k] !== undefined) ex[k] = ic[k]; });
      updated++;
    } else if (!byText.has(norm(ic))) { cards.push(ic); byText.add(norm(ic)); added++; }
  });
  if (!Array.isArray(data) && data.dailyStats) Object.keys(data.dailyStats).forEach(k => { if (!daily[k]) daily[k] = data.dailyStats[k]; });
  return { added, updated };
}
function handleImport(file) {
  if (!file) return;
  const r = new FileReader();
  r.onload = () => {
    let data; try { data = JSON.parse(r.result); } catch (e) { toast('El archivo no es un JSON válido.'); return; }
    const inCards = Array.isArray(data) ? data : data.flashcards || [];
    if (!inCards.length) { toast('El archivo no contiene tarjetas.'); return; }
    const finish = () => { migrateCards(); saveCards(); saveTopics(); saveDaily(); learn.session = null; learn.extraNew = 0; fillAllSelects(); show(currentView === 'settings' ? 'settings' : 'home'); };
    if (!cards.length) { cards = inCards; topics = data.topics || []; daily = data.dailyStats || {}; if (data.settings) settings = { ...settings, ...data.settings }; saveSettings(); finish(); toast(`Importadas ${cards.length} tarjetas ✔`); return; }
    openModal('Importar tarjetas', `<p>El archivo trae <b>${inCards.length}</b> tarjetas. Ya tienes <b>${cards.length}</b>.</p><p class="muted small"><b>Fusionar</b> agrega las nuevas y corrige textos, y conserva tu progreso. <b>Reemplazar</b> borra todo y deja lo del archivo${sync.user ? ' <b>(y también lo borra de la nube y de tus otros dispositivos)</b>' : ''}.</p>`, [
      { label: 'Cancelar', cls: 'ghost' },
      { label: 'Reemplazar', cls: '', fn: () => { cards = inCards; topics = data.topics || []; daily = data.dailyStats || {}; finish(); toast('Datos reemplazados'); } },
      { label: 'Fusionar', cls: 'primary', fn: () => { const r = mergeImport(data); finish(); toast(`${r.added} nuevas, ${r.updated} actualizadas ✔`); } }
    ]);
  };
  r.readAsText(file);
}
['importFile1', 'importFile2'].forEach(id => $(id).addEventListener('change', e => { handleImport(e.target.files[0]); e.target.value = ''; }));

/* ═══════════ MODALES ═══════════ */
function openModal(title, bodyHtml, buttons) {
  $('modalBox').innerHTML = `<h3>${esc(title)}</h3>${bodyHtml}<div class="btn-row">${buttons.map((b, i) => `<button class="btn ${b.cls || ''}" data-i="${i}">${esc(b.label)}</button>`).join('')}</div>`;
  $('modal').style.display = 'grid';
  $('modalBox').querySelectorAll('button[data-i]').forEach(btn => btn.addEventListener('click', () => { const b = buttons[btn.dataset.i]; if (!b.keepOpen) closeModal(); if (b.fn) b.fn(); }));
  const first = $('modalBox').querySelector('input,select'); if (first) first.focus();
}
function closeModal() { $('modal').style.display = 'none'; }
$('modal').addEventListener('click', e => { if (e.target === $('modal')) closeModal(); });
function confirmModal(title, text, onYes) { openModal(title, `<p class="muted">${esc(text)}</p>`, [{ label: 'Cancelar', cls: 'ghost' }, { label: 'Confirmar', cls: 'primary', fn: onYes }]); }
function inputModal(title, value, onOk) {
  openModal(title, `<input class="input" id="modalInput" value="${esc(value)}">`, [{ label: 'Cancelar', cls: 'ghost' }, { label: 'Guardar', cls: 'primary', fn: () => { const v = $('modalInput').value.trim(); if (v) onOk(v); } }]);
}
function editCardModal(c) {
  openModal('Editar tarjeta',
    `<input class="input ko" id="eKo" value="${esc(c.korean)}"><input class="input" id="eEs" value="${esc(c.spanish)}"><select class="select" id="eTopic"><option value="">— Sin carpeta —</option>${topics.map(t => `<option value="${esc(t.id)}" ${t.id === c.topicId ? 'selected' : ''}>${esc(t.name)}</option>`).join('')}</select><input class="input" id="eEx" placeholder="Frase de ejemplo (opcional)" value="${esc(c.example || '')}">`,
    [{ label: 'Cancelar', cls: 'ghost' }, {
      label: 'Guardar', cls: 'primary', keepOpen: true, fn: () => {
        const ko = $('eKo').value.trim(), es = $('eEs').value.trim(); if (!ko || !es) { toast('Completa ambos campos.'); return; }
        c.korean = ko; c.spanish = es; c.topicId = $('eTopic').value || null; const ex = $('eEx').value.trim(); if (ex) c.example = ex; else delete c.example;
        saveCards(); closeModal(); renderCards(); toast('Guardado');
      }
    }]);
}

/* ═══════════ TECLADO ═══════════ */
document.addEventListener('keydown', e => {
  if ($('modal').style.display !== 'none') { if (e.key === 'Escape') closeModal(); return; }
  const tag = (e.target.tagName || '').toLowerCase();
  if (tag === 'input' || tag === 'select' || tag === 'textarea') return;
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  if (currentView === 'learn' && learn.session && $('learnArea').style.display !== 'none') {
    if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); if (!learn.session.revealed) revealLearn(); else rateLearn('good'); }
    else if (learn.session.revealed && ['1', '2', '3'].includes(e.key)) rateLearn(['again', 'good', 'easy'][Number(e.key) - 1]);
    else if (e.key.toLowerCase() === 's') { const c = learn.session.queue[learn.session.index]; if (c) speak(c.korean); }
  }
  if (currentView === 'practice' && prac && $('practiceRun').style.display !== 'none') {
    if (e.key === 'Enter' && $('pNext').style.display !== 'none') { e.preventDefault(); prac.i++; renderQuestion(); }
    else if (['1', '2', '3', '4'].includes(e.key) && prac.mode.startsWith('mc') && !prac.answered) { const b = document.querySelectorAll('#pChoices .choice')[Number(e.key) - 1]; if (b) b.click(); }
  }
});

/* ═══════════ SINCRONIZACIÓN (Firebase: cuenta de Google) ═══════════ */
const FIREBASE_CONFIG = {
  apiKey: 'AIzaSyAK5GhYLM0KZedVbwZdwng-Ay1hPPxsIjk',
  authDomain: 'programa-coreano.firebaseapp.com',
  projectId: 'programa-coreano',
  storageBucket: 'programa-coreano.firebasestorage.app',
  messagingSenderId: '553470082090',
  appId: '1:553470082090:web:90eb18de1b7b0440721753'
};
const plain = (o) => JSON.parse(JSON.stringify(o));
function cardJson(c) { const r = {}; Object.keys(c).sort().forEach(k => { if (k !== 'updated') r[k] = c[k]; }); return JSON.stringify(r); }
function derivedStamp(c) { return Math.max(Date.parse(c.created) || 0, Date.parse(c.lastSeenLearn) || 0); }

// Cada vez que se guardan las tarjetas se detecta qué cambió: lo cambiado se marca con la hora
// y se envía a la nube; lo borrado se envía como "lápida" para que se borre en el otro dispositivo.
function syncTrack() {
  if (sync.applying) return;
  const now = Date.now(); let changed = false; const seen = new Set();
  cards.forEach(c => {
    seen.add(c.id);
    const j = cardJson(c), prev = sync.lastJson.get(c.id);
    if (prev === j) return;
    c.updated = prev === undefined ? (c.updated || derivedStamp(c) || now) : now;
    sync.lastJson.set(c.id, j); changed = true;
    if (sync.user) sync.queue.set(c.id, plain(c));
  });
  [...sync.lastJson.keys()].forEach(id => {
    if (seen.has(id)) return;
    sync.lastJson.delete(id); sync.pendingDel[id] = now; changed = true;
    if (sync.user) sync.queue.set(id, { id, deleted: true, updated: now });
  });
  if (changed) { lsSet(KEYS.pending, sync.pendingDel); if (sync.user) schedulePush(); }
}
function topicsTrack() {
  if (sync.applying) return;
  const j = JSON.stringify(topics); if (j === syncMeta.topicsJson) return;
  const now = Date.now();
  const prevIds = JSON.parse(syncMeta.topicsJson || '[]').map(t => t.id);
  prevIds.forEach(id => { if (!topics.some(t => t.id === id)) syncMeta.delTopics[id] = now; });
  syncMeta.topicsJson = j; syncMeta.topicsUpdated = now; lsSet(KEYS.syncMeta, syncMeta); pushMetaSoon();
}
function settingsTrack() {
  if (sync.applying) return;
  const j = JSON.stringify([settings.newPerDay, settings.maxReviews, settings.auto]); if (j === syncMeta.settingsJson) return;
  syncMeta.settingsJson = j; syncMeta.settingsUpdated = Date.now(); lsSet(KEYS.syncMeta, syncMeta); pushMetaSoon();
}
function syncBaseline() {
  let fix = false;
  cards.forEach(c => { if (!c.updated) { c.updated = derivedStamp(c); fix = true; } sync.lastJson.set(c.id, cardJson(c)); });
  if (fix) lsSet(KEYS.cards, cards);
  syncMeta.topicsJson = JSON.stringify(topics);
  syncMeta.settingsJson = JSON.stringify([settings.newPerDay, settings.maxReviews, settings.auto]);
}

function setStatus(s, err) { sync.status = s; sync.err = err || ''; renderSyncUi(); }
function renderSyncUi() {
  const el = $('syncStatus'), home = $('syncHome'); if (!el) return;
  let t;
  if (sync.status === 'nofb') t = '⚠️ No se pudo cargar el servicio de sincronización. Revisa tu conexión y recarga la página.';
  else if (!sync.user) t = 'Sin sincronizar. Inicia sesión para tener las mismas tarjetas y el mismo avance en todos tus dispositivos.';
  else if (sync.status === 'error') t = sync.err === 'permission-denied' ? '⚠️ Firebase no deja guardar: revisa que publicaste las reglas de Firestore.' : '⚠️ Error de sincronización' + (sync.err ? ' (' + sync.err + ')' : '') + '. Se reintenta solo.';
  else if (!navigator.onLine) t = '📴 Sin conexión · los cambios se enviarán cuando vuelva internet.';
  else if (sync.status === 'syncing') t = '🔄 Sincronizando…';
  else t = '☁️ Sincronizado · ' + (sync.user.email || '');
  el.textContent = t;
  if (home) home.textContent = !sync.user ? '☁️ Sin sincronizar · toca para iniciar sesión' : t;
  $('syncLogin').style.display = sync.user || sync.status === 'nofb' ? 'none' : '';
  $('syncLogout').style.display = sync.user ? '' : 'none';
}

function initSync() {
  if (!window.firebase || !firebase.initializeApp) { setStatus('nofb'); return; }
  try {
    firebase.initializeApp(FIREBASE_CONFIG);
    sync.auth = firebase.auth(); sync.db = firebase.firestore();
    try { const p = sync.db.enablePersistence({ synchronizeTabs: true }); if (p && p.catch) p.catch(() => { }); } catch (e) { }
    sync.auth.onAuthStateChanged(onUser);
  } catch (e) { console.warn(e); setStatus('nofb'); }
  window.addEventListener('online', renderSyncUi); window.addEventListener('offline', renderSyncUi);
}
function onUser(u) {
  sync.unsubs.forEach(f => { try { f(); } catch (e) { } }); sync.unsubs = [];
  clearTimeout(sync.timer); clearTimeout(sync.mTimer); sync.metaSeen = false; sync.cardsSeen = false; sync.queue.clear();
  sync.user = u || null; sync.base = u ? 'users/' + u.uid : '';
  if (!u) { setStatus('off'); return; }
  setStatus('syncing');
  Object.keys(sync.pendingDel).forEach(id => sync.queue.set(Number(id), { id: Number(id), deleted: true, updated: sync.pendingDel[id] }));
  const onErr = (e) => { console.warn('sync', e); setStatus('error', e && e.code); };
  sync.unsubs.push(sync.db.doc(sync.base + '/meta/state').onSnapshot(onMetaSnap, onErr));
  sync.unsubs.push(sync.db.collection(sync.base + '/cards').onSnapshot(onCardsSnap, onErr));
}

function schedulePush() { if (!sync.user) return; clearTimeout(sync.timer); setStatus('syncing'); sync.timer = setTimeout(flushPush, 700); }
async function flushPush() {
  if (!sync.user || !sync.queue.size) { if (sync.user && sync.status === 'syncing' && sync.cardsSeen) setStatus('ok'); return; }
  const items = [...sync.queue.entries()]; sync.queue.clear();
  try {
    for (let i = 0; i < items.length; i += 400) {
      const b = sync.db.batch();
      items.slice(i, i + 400).forEach(([id, d]) => b.set(sync.db.doc(sync.base + '/cards/' + id), d));
      await b.commit();
    }
    items.forEach(([id, d]) => { if (d.deleted) delete sync.pendingDel[id]; }); lsSet(KEYS.pending, sync.pendingDel);
    if (!sync.queue.size) setStatus('ok');
  } catch (e) {
    console.warn('push', e); items.forEach(([id, d]) => { if (!sync.queue.has(id)) sync.queue.set(id, d); });
    setStatus('error', e && e.code); setTimeout(schedulePush, 15000);
  }
}

function refreshView() {
  fillAllSelects();
  if (currentView === 'home') renderHome();
  else if (currentView === 'cards') renderCards();
  else if (currentView === 'folders') renderFolders();
  else if (currentView === 'progress') renderProgress();
  else if (currentView === 'settings') renderSettings();
}

function onCardsSnap(snap) {
  const first = !sync.cardsSeen; sync.cardsSeen = true;
  let changed = false; const remoteIds = new Set();
  const byId = new Map(cards.map(c => [c.id, c]));
  sync.applying = true;
  try {
    snap.docChanges().forEach(ch => {
      if (ch.type === 'removed') return;
      remoteIds.add(Number(ch.doc.id));
      if (ch.doc.metadata && ch.doc.metadata.hasPendingWrites) return;
      const r = ch.doc.data(), id = Number(ch.doc.id), ru = r.updated || 0, local = byId.get(id);
      if (r.deleted) {
        if (local && ru >= (local.updated || 0)) { cards = cards.filter(c => c.id !== id); byId.delete(id); sync.lastJson.delete(id); changed = true; }
        else if (local) sync.queue.set(id, plain(local));
        return;
      }
      if (!local) {
        const pend = sync.pendingDel[id];
        if (pend && pend >= ru) { sync.queue.set(id, { id, deleted: true, updated: pend }); return; }
        const c = plain(r); cards.push(c); byId.set(id, c); sync.lastJson.set(id, cardJson(c)); changed = true;
      } else if (ru > (local.updated || 0)) {
        Object.keys(local).forEach(k => delete local[k]); Object.assign(local, plain(r));
        sync.lastJson.set(id, cardJson(local)); changed = true;
      } else if (ru < (local.updated || 0)) sync.queue.set(id, plain(local));
    });
    // primera carga: lo que solo existe en este dispositivo se sube
    if (first) cards.forEach(c => { if (!remoteIds.has(c.id) && !sync.queue.has(c.id)) sync.queue.set(c.id, plain(c)); });
  } finally { sync.applying = false; }
  if (changed) { lsSet(KEYS.cards, cards); refreshView(); }
  if (sync.queue.size) schedulePush(); else if (first || changed) setStatus('ok');
}

function onMetaSnap(snap) {
  if (snap.metadata && snap.metadata.hasPendingWrites) return;
  sync.metaSeen = true;
  if (!snap.exists) { pushMeta(); return; }
  const r = snap.data(); let changed = false, needPush = false;
  sync.applying = true;
  try {
    // carpetas: se unen las dos listas; el nombre lo decide la modificación más reciente; las borradas quedan borradas
    const del = { ...(r.deletedTopics || {}) }; Object.keys(syncMeta.delTopics).forEach(k => { del[k] = Math.max(del[k] || 0, syncMeta.delTopics[k]); });
    const localNewer = (syncMeta.topicsUpdated || 0) >= (r.topicsUpdated || 0);
    const map = new Map((r.topics || []).map(t => [t.id, { ...t }]));
    topics.forEach(t => { if (map.has(t.id)) { if (localNewer) map.get(t.id).name = t.name; } else map.set(t.id, { ...t }); });
    const nt = [...map.values()].filter(t => !del[t.id]);
    if (JSON.stringify(nt) !== JSON.stringify(topics)) { topics = nt; changed = true; }
    if (JSON.stringify(del) !== JSON.stringify(syncMeta.delTopics)) { syncMeta.delTopics = del; }
    if (JSON.stringify(nt) !== JSON.stringify(r.topics || []) || Object.keys(del).some(k => !(r.deletedTopics || {})[k])) needPush = true;
    syncMeta.topicsUpdated = Math.max(syncMeta.topicsUpdated || 0, r.topicsUpdated || 0);
    syncMeta.topicsJson = JSON.stringify(topics);
    // estadísticas diarias: se queda con el valor más alto de cada día
    const rd = r.daily || {};
    Object.keys(rd).forEach(k => {
      const l = daily[k] || (daily[k] = { dificil: 0, medio: 0, facil: 0 });
      ['dificil', 'medio', 'facil'].forEach(f => { const v = rd[k][f] || 0; if (v > (l[f] || 0)) { l[f] = v; changed = true; } else if ((l[f] || 0) > v) needPush = true; });
    });
    Object.keys(daily).forEach(k => { if (!rd[k]) needPush = true; });
    // ajustes de estudio
    if ((r.settingsUpdated || 0) > (syncMeta.settingsUpdated || 0) && r.settings) {
      ['newPerDay', 'maxReviews', 'auto'].forEach(k => { if (r.settings[k] !== undefined) settings[k] = r.settings[k]; });
      syncMeta.settingsUpdated = r.settingsUpdated; syncMeta.settingsJson = JSON.stringify([settings.newPerDay, settings.maxReviews, settings.auto]);
      lsSet(KEYS.settings, settings); changed = true;
    } else if ((r.settingsUpdated || 0) < (syncMeta.settingsUpdated || 0)) needPush = true;
  } finally { sync.applying = false; }
  lsSet(KEYS.topics, topics); lsSet(KEYS.daily, daily); lsSet(KEYS.syncMeta, syncMeta);
  if (needPush) pushMetaSoon();
  if (changed) refreshView();
}
function pushMetaSoon() { if (!sync.user || sync.applying) return; clearTimeout(sync.mTimer); sync.mTimer = setTimeout(pushMeta, 900); }
function pushMeta() {
  if (!sync.user || !sync.metaSeen) return;
  if (!syncMeta.topicsUpdated) syncMeta.topicsUpdated = Date.now();
  if (!syncMeta.settingsUpdated) syncMeta.settingsUpdated = Date.now();
  lsSet(KEYS.syncMeta, syncMeta);
  sync.db.doc(sync.base + '/meta/state').set({
    topics: plain(topics), topicsUpdated: syncMeta.topicsUpdated, deletedTopics: plain(syncMeta.delTopics),
    daily: plain(daily), settings: { newPerDay: settings.newPerDay, maxReviews: settings.maxReviews, auto: !!settings.auto }, settingsUpdated: syncMeta.settingsUpdated
  }, { merge: true }).then(() => { if (!sync.queue.size) setStatus('ok'); }).catch(e => { console.warn(e); setStatus('error', e && e.code); });
}

$('syncLogin').addEventListener('click', async () => {
  if (!sync.auth) { toast('El servicio de sincronización no está disponible.'); return; }
  try { await sync.auth.signInWithPopup(new firebase.auth.GoogleAuthProvider()); }
  catch (e) {
    const m = { 'auth/popup-blocked': 'El navegador bloqueó la ventana de Google. Permite ventanas emergentes para este sitio.', 'auth/popup-closed-by-user': 'Cerraste la ventana antes de terminar.', 'auth/unauthorized-domain': 'Este dominio no está autorizado en Firebase (Authentication → Settings → Authorized domains).', 'auth/operation-not-allowed': 'El inicio con Google no está activado en Firebase.' };
    toast(m[e.code] || 'No se pudo iniciar sesión: ' + (e.code || e.message));
  }
});
$('syncLogout').addEventListener('click', () => confirmModal('¿Cerrar sesión?', 'Dejarás de sincronizar. Tus tarjetas quedan guardadas en este dispositivo y siguen en la nube.', () => sync.auth.signOut()));
$('syncHome').addEventListener('click', () => show('settings'));

/* ═══════════ INICIO ═══════════ */
(function init() {
  cards = lsGet(KEYS.cards, []);
  topics = lsGet(KEYS.topics, []);
  daily = lsGet(KEYS.daily, {});
  settings = { ...settings, ...lsGet(KEYS.settings, {}) };
  if (localStorage.getItem(KEYS.dark) === '1') { document.body.classList.add('dark'); $('darkBtn').textContent = '☀️'; }
  syncMeta = { ...syncMeta, ...lsGet(KEYS.syncMeta, {}) }; syncMeta.delTopics = syncMeta.delTopics || {};
  sync.pendingDel = lsGet(KEYS.pending, {});
  migrateCards();
  syncBaseline();
  fillAllSelects();
  try { if (navigator.storage && navigator.storage.persist) navigator.storage.persist(); } catch (e) { }
  show('home');
  initSync();
})();

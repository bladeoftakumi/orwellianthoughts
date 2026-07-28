// Doublethink shared data contract.
// Single source of truth for the shape of figures, entries, and doublethink flags.
// Imported by BOTH the web app (browser, via dynamic import) and the ingestion
// agent (Node, via `import`). No browser- or Node-specific APIs so it runs in both.
//
// Every validator returns { ok: boolean, errors: string[], value: <normalized> }.
// `value` is always a clean, contract-shaped object safe to persist, even when
// ok is false (so callers can inspect), but callers MUST NOT write when ok is false.

// ---- Enumerations -----------------------------------------------------------

export const CATEGORIES = ['promise', 'claim'];

// Entry "type" is the kind of thing said/done. Promises use promise/action/vote;
// claims use statement. Kept permissive so the agent can tag precisely.
export const ENTRY_TYPES = ['promise', 'statement', 'action', 'vote'];

// Status vocabularies differ by category. The first value is the natural
// "just recorded" default for that category.
export const PROMISE_STATUSES = ['pending', 'partial', 'kept', 'broken'];
export const CLAIM_STATUSES = ['review', 'held', 'reversed_ack', 'reversed_unack', 'denied'];

export const SOURCE_KINDS = ['article', 'video', 'transcript'];

export function statusesFor(category) {
  return category === 'claim' ? CLAIM_STATUSES : PROMISE_STATUSES;
}
export function defaultStatusFor(category) {
  return category === 'claim' ? 'held' : 'pending';
}
export function typeFor(category) {
  return category === 'claim' ? 'statement' : 'promise';
}

// ---- Small helpers ----------------------------------------------------------

export function isYMD(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(s + 'T00:00:00Z');
  return !isNaN(d.getTime()) && s === d.toISOString().slice(0, 10);
}
function str(v) { return typeof v === 'string' ? v.trim() : ''; }
function isUrl(v) {
  const s = str(v);
  return /^https?:\/\/[^\s.]+\.[^\s]+$/.test(s);
}
let _seq = 0;
export function makeId(prefix) {
  _seq = (_seq + 1) % 100000;
  return (prefix || 'id') + '_' + Date.now().toString(36) + _seq.toString(36);
}

// ---- Factories (blank, contract-shaped objects) -----------------------------

export function blankSource() { return { kind: 'article', label: '', outlet: '', url: '' }; }
export function blankUpdate(label, status) {
  return { id: makeId('u'), date: new Date().toISOString().slice(0, 10), status: status || 'pending', label: label || '', note: '', sources: [blankSource()] };
}
export function blankEntry(category) {
  const cat = category === 'claim' ? 'claim' : 'promise';
  return { id: makeId('e'), category: cat, type: typeFor(cat), tags: [], claim: '', context: '',
    updates: [blankUpdate(cat === 'claim' ? 'Claim made' : 'Promise made', defaultStatusFor(cat))] };
}
export function blankCase() { return { date: '', actorJudged: '', action: '', verdict: '', sources: [blankSource()] }; }
export function blankFlag(figureId) {
  return { id: makeId('fl'), figureId: figureId || '', caseA: blankCase(), caseB: blankCase(),
    similarityAxes: [], subjectDistinction: '', publishSentence: '', reviewedBy: '', reviewedAt: '' };
}
export function blankFigure() {
  return { id: makeId('f'), name: '', role: '', country: '', state: '', city: '', photo: '', birth: '', monogram: '', milestones: [], entries: [] };
}

// ---- Normalizers ------------------------------------------------------------

export function monogramFor(name) {
  const parts = String(name || '').replace(/^(sen|gov|rep|sec|mayor|dr|mr|ms|mrs|president)\.?\s+/i, '').trim().split(/\s+/);
  const a = (parts[0] || '')[0] || '';
  const b = (parts[1] || '')[0] || '';
  return (a + b).toUpperCase() || 'NA';
}
export function normSource(s) {
  s = s || {};
  return { kind: SOURCE_KINDS.includes(s.kind) ? s.kind : 'article', label: str(s.label) || 'Source', outlet: str(s.outlet), url: str(s.url) || '#' };
}
export function normUpdate(u, category) {
  u = u || {};
  const allowed = statusesFor(category);
  return { id: str(u.id) || makeId('u'), date: str(u.date), status: allowed.includes(u.status) ? u.status : defaultStatusFor(category),
    label: str(u.label), note: str(u.note), sources: Array.isArray(u.sources) ? u.sources.map(normSource) : [] };
}
export function normEntry(e) {
  e = e || {};
  const cat = e.category === 'claim' ? 'claim' : 'promise';
  // Back-compat: entries that predate the updates[] model carried a flat date/status.
  let updates = Array.isArray(e.updates) && e.updates.length
    ? e.updates
    : [{ id: (e.id || 'e') + '_u0', date: e.date, status: e.status, label: 'Recorded', note: '', sources: e.sources || [] }];
  updates = updates.map(u => normUpdate(u, cat)).sort((a, b) => String(a.date).localeCompare(String(b.date)));
  return { id: str(e.id) || makeId('e'), category: cat, type: ENTRY_TYPES.includes(e.type) ? e.type : typeFor(cat),
    tags: Array.isArray(e.tags) ? e.tags.map(str).filter(Boolean) : [], claim: str(e.claim), context: str(e.context), updates };
}
export function normCase(c) {
  c = c || {};
  return { date: str(c.date), actorJudged: str(c.actorJudged), action: str(c.action), verdict: str(c.verdict),
    sources: Array.isArray(c.sources) ? c.sources.map(normSource) : [] };
}
export function normFlag(fl) {
  fl = fl || {};
  return { id: str(fl.id) || makeId('fl'), figureId: str(fl.figureId), caseA: normCase(fl.caseA), caseB: normCase(fl.caseB),
    similarityAxes: Array.isArray(fl.similarityAxes) ? fl.similarityAxes.map(str).filter(Boolean) : [],
    subjectDistinction: str(fl.subjectDistinction), publishSentence: str(fl.publishSentence),
    reviewedBy: str(fl.reviewedBy), reviewedAt: str(fl.reviewedAt) };
}
export function normFigure(f) {
  f = f || {};
  return { id: str(f.id) || makeId('f'), name: str(f.name), role: str(f.role), country: str(f.country), state: str(f.state),
    city: str(f.city), photo: str(f.photo), birth: str(f.birth), monogram: str(f.monogram) || monogramFor(f.name),
    milestones: Array.isArray(f.milestones) ? f.milestones.map(m => ({ date: str(m && m.date), label: str(m && m.label) })).filter(m => m.date && m.label) : [],
    entries: Array.isArray(f.entries) ? f.entries.map(normEntry) : [] };
}

// ---- Validators -------------------------------------------------------------
// opts.requireSources (default true): every dated update / case needs at least
// one source with a real http(s) URL. The agent path keeps this on so AI output
// is never published unsourced; the manual UI may pass { requireSources:false }.

export function validateSource(s, opts, path, errors) {
  const n = normSource(s);
  if (opts.requireSources !== false && !isUrl(n.url)) errors.push((path || 'source') + ': needs a valid http(s) URL');
  return n;
}
export function validateEntry(entry, opts) {
  opts = opts || {};
  const errors = [];
  const v = normEntry(entry);
  if (!v.claim) errors.push('entry: the promise or claim text is required');
  if (!CATEGORIES.includes(v.category)) errors.push('entry: category must be promise or claim');
  if (!v.updates.length) errors.push('entry: at least one dated update is required');
  const allowed = statusesFor(v.category);
  v.updates.forEach((u, i) => {
    if (!isYMD(u.date)) errors.push('update ' + (i + 1) + ': date must be YYYY-MM-DD');
    if (!allowed.includes(u.status)) errors.push('update ' + (i + 1) + ': status must be one of ' + allowed.join(', '));
    const withUrl = (u.sources || []).filter(s => isUrl(s.url));
    if (opts.requireSources !== false && withUrl.length === 0) errors.push('update ' + (i + 1) + ': needs at least one source with a valid URL');
    u.sources.forEach((s, j) => validateSource(s, opts, 'update ' + (i + 1) + ' source ' + (j + 1), errors));
  });
  return { ok: errors.length === 0, errors, value: v };
}
export function validateFlag(flag, opts) {
  opts = opts || {};
  const errors = [];
  const v = normFlag(flag);
  if (!v.figureId) errors.push('flag: figureId is required');
  ['caseA', 'caseB'].forEach(k => {
    const c = v[k];
    if (!isYMD(c.date)) errors.push(k + ': date must be YYYY-MM-DD');
    if (!c.actorJudged) errors.push(k + ': the actor being judged is required');
    if (!c.action) errors.push(k + ': the action being judged is required');
    if (!c.verdict) errors.push(k + ': the verdict is required');
    const withUrl = (c.sources || []).filter(s => isUrl(s.url));
    if (opts.requireSources !== false && withUrl.length === 0) errors.push(k + ': needs at least one source with a valid URL');
  });
  if (v.caseA.verdict && v.caseB.verdict && v.caseA.verdict.toLowerCase() === v.caseB.verdict.toLowerCase())
    errors.push('flag: the two verdicts must be opposite; a flag records the same action judged two different ways');
  if (v.similarityAxes.length === 0) errors.push('flag: name at least one axis the two cases are similar on');
  if (!v.subjectDistinction) errors.push("flag: record the subject's own distinction, or note they have never addressed it");
  if (!v.publishSentence) errors.push('flag: a publish sentence is required');
  return { ok: errors.length === 0, errors, value: v };
}
export function validateFigure(figure, opts) {
  opts = opts || {};
  const errors = [];
  const v = normFigure(figure);
  if (!v.name) errors.push('figure: name is required');
  if (!v.role) errors.push('figure: role is required');
  if (v.birth && !isYMD(v.birth)) errors.push('figure: birth date must be YYYY-MM-DD when given');
  v.entries.forEach((e, i) => {
    const r = validateEntry(e, opts);
    if (!r.ok) r.errors.forEach(msg => errors.push('entry ' + (i + 1) + ': ' + msg));
  });
  return { ok: errors.length === 0, errors, value: v };
}

// Convenience: validate a whole agent payload of { figure, entries?, flags? }.
export function validatePayload(payload, opts) {
  opts = opts || {};
  const errors = [];
  const figRes = validateFigure(payload && payload.figure ? payload.figure : {}, opts);
  if (!figRes.ok) figRes.errors.forEach(m => errors.push('figure: ' + m));
  const entries = Array.isArray(payload && payload.entries) ? payload.entries : [];
  const entriesOut = entries.map((e, i) => {
    const r = validateEntry(e, opts);
    if (!r.ok) r.errors.forEach(m => errors.push('entry ' + (i + 1) + ': ' + m));
    return r.value;
  });
  const flags = Array.isArray(payload && payload.flags) ? payload.flags : [];
  const flagsOut = flags.map((f, i) => {
    const r = validateFlag(f, opts);
    if (!r.ok) r.errors.forEach(m => errors.push('flag ' + (i + 1) + ': ' + m));
    return r.value;
  });
  return { ok: errors.length === 0, errors, value: { figure: figRes.value, entries: entriesOut, flags: flagsOut } };
}

export const SCHEMA_VERSION = 1;

// Doublethink agent API — a small command interface for research agents.
//
// Agents authenticate with a per-agent API key (created by the main admin in
// the admin portal) and send:  POST <function url>  { "command": "...", "args": {...} }
// with header  Authorization: Bearer dtk_...
//
// Agents can READ the public record and SUBMIT DRAFTS. Nothing an agent sends
// is published: every write lands in the `drafts` review queue, where a human
// approves or rejects it in the admin portal. This module never writes to
// figures, flags, articles, or users.

const crypto = require('crypto');

const KEY_PREFIX = 'dtk_';
const CACHE_MS = 60 * 1000;            // figure list + key lookups are cached per instance
const MAX_BODY_BYTES = 100 * 1024;     // a single request may not exceed 100 KB
const REQS_PER_MINUTE = 120;           // per key, per instance
const DEFAULT_DAILY_WRITES = 100;      // drafts per key per UTC day (configurable per key)

let schemaPromise = null;
function loadSchema() {
  // schema.mjs is copied from the repo-root schema.js at deploy time (see firebase.json).
  if (!schemaPromise) schemaPromise = import('./schema.mjs');
  return schemaPromise;
}

function hashKey(key) { return crypto.createHash('sha256').update(String(key)).digest('hex'); }
function newKey() { return KEY_PREFIX + crypto.randomBytes(24).toString('base64url'); }
function today() { return new Date().toISOString().slice(0, 10); }
function draftId() { return 'dr_' + Date.now().toString(36) + crypto.randomBytes(4).toString('hex'); }

class ApiError extends Error {
  constructor(status, code, message, details) { super(message); this.status = status; this.code = code; this.details = details; }
}

// ---- Text helpers for search and duplicate detection -------------------------

const TITLES = /^(sen|senator|gov|governor|rep|representative|sec|secretary|mayor|dr|mr|ms|mrs|president|pm|vp)\.?\s+/i;
function normText(s) {
  return String(s || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
}
function normName(s) { return normText(String(s || '').replace(TITLES, '')); }
function tokens(s) { return new Set(normText(s).split(' ').filter(w => w.length > 2)); }
function similarity(a, b) {
  const A = tokens(a), B = tokens(b);
  if (!A.size || !B.size) return 0;
  let inter = 0; A.forEach(w => { if (B.has(w)) inter++; });
  return inter / (A.size + B.size - inter);
}

function createAgentApi(db) {
  const keyCache = new Map();          // hash -> { at, data }
  const rate = new Map();              // hash -> { minute, count }
  let figCache = { at: 0, list: null };

  // ---- Auth & limits ---------------------------------------------------------

  async function authenticate(req) {
    const h = req.get('authorization') || '';
    const key = (h.match(/^Bearer\s+(.+)$/i) || [])[1] || req.get('x-api-key') || '';
    if (!key.startsWith(KEY_PREFIX)) throw new ApiError(401, 'unauthenticated', 'Send your agent key as "Authorization: Bearer dtk_...".');
    const hash = hashKey(key.trim());
    let hit = keyCache.get(hash);
    if (!hit || Date.now() - hit.at > CACHE_MS) {
      const snap = await db.doc('agentKeys/' + hash).get();
      hit = { at: Date.now(), data: snap.exists ? snap.data() : null };
      keyCache.set(hash, hit);
    }
    if (!hit.data || hit.data.active !== true) throw new ApiError(401, 'unauthenticated', 'This agent key is unknown or has been revoked.');

    const minute = Math.floor(Date.now() / 60000);
    const r = rate.get(hash);
    if (r && r.minute === minute) {
      if (++r.count > REQS_PER_MINUTE) throw new ApiError(429, 'rate_limited', 'Too many requests; slow down and retry in a minute.');
    } else rate.set(hash, { minute, count: 1 });

    return { hash, ...hit.data };
  }

  // Count one draft against the key's daily limit (transactional, all instances).
  async function consumeWrite(agent) {
    const ref = db.doc('agentKeys/' + agent.hash);
    await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      const d = snap.data() || {};
      if (d.active !== true) throw new ApiError(401, 'unauthenticated', 'This agent key has been revoked.');
      const limit = Number(d.dailyLimit) || DEFAULT_DAILY_WRITES;
      const used = d.day === today() ? (d.writesToday || 0) : 0;
      if (used >= limit) throw new ApiError(429, 'daily_limit', 'This key has used its ' + limit + ' drafts for today (UTC).');
      tx.update(ref, { day: today(), writesToday: used + 1, lastUsed: Date.now() });
    });
  }

  // ---- Data access -----------------------------------------------------------

  async function allFigures() {
    if (!figCache.list || Date.now() - figCache.at > CACHE_MS) {
      const snap = await db.collection('figures').get();
      figCache = { at: Date.now(), list: snap.docs.map(d => ({ ...d.data(), id: d.id })) };
    }
    return figCache.list;
  }
  async function getFigure(id) {
    if (!id || typeof id !== 'string') throw new ApiError(400, 'invalid_argument', 'figureId is required.');
    const snap = await db.doc('figures/' + id).get();
    if (!snap.exists) throw new ApiError(404, 'not_found', 'No figure with id "' + id + '". Use search_figures to find it.');
    return { ...snap.data(), id: snap.id };
  }
  async function pendingDrafts() {
    const snap = await db.collection('drafts').where('status', '==', 'pending').get();
    return snap.docs.map(d => ({ ...d.data(), id: d.id }));
  }

  function summarizeFigure(f) {
    const entries = Array.isArray(f.entries) ? f.entries : [];
    return { id: f.id, name: f.name || '', role: f.role || '', country: f.country || '', state: f.state || '', city: f.city || '',
      promises: entries.filter(e => e.category !== 'claim').length, claims: entries.filter(e => e.category === 'claim').length };
  }

  async function submitDraft(agent, { title, summary, target, payload }) {
    await consumeWrite(agent);
    const S = await loadSchema();
    const id = draftId();
    const draft = {
      id, source: 'agent', status: 'pending', stage: 'submitted',
      submittedBy: 'Agent: ' + agent.name, agentName: agent.name, agentKeyId: agent.hash,
      title: String(title || 'Untitled draft').slice(0, 200), summary: String(summary || '').slice(0, 2000), note: String(summary || '').slice(0, 2000),
      created: Date.now(), schemaVersion: S.SCHEMA_VERSION, target, payload: JSON.parse(JSON.stringify(payload)),
    };
    const batch = db.batch();
    batch.set(db.doc('drafts/' + id), draft);
    batch.set(db.doc('agentKeys/' + agent.hash + '/submissions/' + id), { title: draft.title, kind: kindOf(target), created: draft.created });
    await batch.commit();
    return { draftId: id, status: 'pending', message: 'Submitted to the review queue. A human reviewer must approve it before it is public.' };
  }

  function kindOf(t) {
    if (!t || t.mode !== 'existing') return 'new_figure';
    if (t.replaceEntryId) return 'entry_update';
    return 'addition';
  }

  function requireValid(res) {
    if (!res.ok) throw new ApiError(422, 'invalid_payload', 'The submission does not meet the data contract.', res.errors);
    return res.value;
  }

  // ---- Commands --------------------------------------------------------------

  const commands = {
    async help() {
      const S = await loadSchema();
      return {
        about: 'Doublethink agent API. Read the public record and submit drafts for human review. Nothing you submit is published until a reviewer approves it.',
        request: 'POST JSON { "command": "<name>", "args": { ... } } with header Authorization: Bearer <your key>.',
        rules: [
          'Search before you submit: use search_figures and get_figure so you do not create duplicates.',
          'Every update, and both cases of a flag, needs at least one source with a real http(s) URL you actually read.',
          'Dates are YYYY-MM-DD. Record what happened, not opinion; the status must reflect a verifiable outcome.',
          'To record progress on an existing promise or claim, use add_update; do not propose a second entry for it.',
        ],
        enums: { categories: S.CATEGORIES, entryTypes: S.ENTRY_TYPES, promiseStatuses: S.PROMISE_STATUSES, claimStatuses: S.CLAIM_STATUSES, sourceKinds: S.SOURCE_KINDS },
        commands: {
          help: 'This document.',
          whoami: 'Your agent name and today\'s draft usage.',
          search_figures: '{ query?: string, limit?: number<=50 } -> matching figures with entry counts.',
          get_figure: '{ figureId } -> the full figure, including every entry and its dated updates.',
          propose_figure: '{ figure: {name, role, country?, state?, city?, birth?, milestones?}, entries?: Entry[], flags?: Flag[], summary?, force?: boolean } -> draft for a NEW figure.',
          propose_entry: '{ figureId, entry: Entry, summary?, force?: boolean } -> draft adding a promise or claim to an existing figure.',
          add_update: '{ figureId, entryId, update: {date, status, label, note?, sources: Source[]}, summary? } -> draft appending a dated update to an existing entry.',
          propose_flag: '{ figureId, flag: Flag, summary? } -> draft adding a doublethink flag to an existing figure.',
          list_my_drafts: '{ } -> your recent submissions and whether each is still pending.',
          get_draft: '{ draftId } -> one of your pending drafts in full.',
        },
        shapes: {
          Source: '{ kind: "article"|"video"|"transcript", label, outlet, url }',
          Entry: '{ category: "promise"|"claim", type?, tags?: string[], claim, context?, updates: Update[] }',
          Update: '{ date: "YYYY-MM-DD", status, label, note?, sources: Source[] } (promise statuses for promises, claim statuses for claims)',
          Flag: '{ caseA: Case, caseB: Case, similarityAxes: string[], subjectDistinction, publishSentence }',
          Case: '{ date, actorJudged, action, verdict, sources: Source[] }',
        },
      };
    },

    async whoami(agent) {
      const snap = await db.doc('agentKeys/' + agent.hash).get();
      const d = snap.data() || {};
      return { name: d.name, dailyLimit: Number(d.dailyLimit) || DEFAULT_DAILY_WRITES, draftsToday: d.day === today() ? (d.writesToday || 0) : 0 };
    },

    async search_figures(agent, args) {
      const q = normText(args.query || '');
      const limit = Math.min(Math.max(parseInt(args.limit, 10) || 20, 1), 50);
      const figs = await allFigures();
      const words = q ? q.split(' ') : [];
      const scored = figs.map(f => {
        const name = normName(f.name);
        const hay = [name, normText(f.role), normText(f.country), normText(f.state), normText(f.city)].join(' ');
        let score = !words.length ? 1 : words.every(w => hay.includes(w)) ? 1 + (name.includes(q) ? 2 : 0) + (name === normName(q) ? 4 : 0) : 0;
        return { f, score };
      }).filter(x => x.score > 0).sort((a, b) => b.score - a.score || String(a.f.name).localeCompare(String(b.f.name)));
      return { total: scored.length, figures: scored.slice(0, limit).map(x => summarizeFigure(x.f)) };
    },

    async get_figure(agent, args) {
      const f = await getFigure(args.figureId);
      return { ...summarizeFigure(f), birth: f.birth || '', milestones: f.milestones || [],
        entries: (f.entries || []).map(e => ({ id: e.id, category: e.category, type: e.type, tags: e.tags || [], claim: e.claim, context: e.context || '', updates: e.updates || [] })) };
    },

    async propose_figure(agent, args) {
      const S = await loadSchema();
      if (!args.figure || typeof args.figure !== 'object') throw new ApiError(400, 'invalid_argument', 'figure is required.');
      const figure = S.normFigure({ ...args.figure, entries: [] });
      // A new figure's flags point at the id this figure will have once approved.
      const flags = (Array.isArray(args.flags) ? args.flags : []).map(fl => ({ ...(fl || {}), figureId: figure.id }));
      const v = requireValid(S.validatePayload({ figure, entries: args.entries || [], flags }, { requireSources: true }));

      if (!args.force) {
        const name = normName(v.figure.name);
        const existing = (await allFigures()).filter(f => normName(f.name) === name);
        if (existing.length) throw new ApiError(409, 'duplicate', 'A figure with this name already exists. Add to it with propose_entry/add_update, or pass force:true if it is genuinely a different person.', existing.map(summarizeFigure));
        const queued = (await pendingDrafts()).filter(d => !(d.target && d.target.mode === 'existing') && d.payload && d.payload.figure && normName(d.payload.figure.name) === name);
        if (queued.length) throw new ApiError(409, 'duplicate', 'A draft for this figure is already waiting for review.', queued.map(d => ({ draftId: d.id, title: d.title })));
      }
      return submitDraft(agent, { title: v.figure.name, summary: args.summary || ('New figure with ' + v.entries.length + ' entries.'), target: { mode: 'new' }, payload: v });
    },

    async propose_entry(agent, args) {
      const S = await loadSchema();
      const f = await getFigure(args.figureId);
      if (!args.entry || typeof args.entry !== 'object') throw new ApiError(400, 'invalid_argument', 'entry is required.');
      const v = requireValid(S.validateAdditions({ entries: [args.entry] }, f.id, { requireSources: true }));
      const entry = v.entries[0];
      if (!args.force) {
        const dupes = (f.entries || []).filter(e => normText(e.claim) === normText(entry.claim) || similarity(e.claim, entry.claim) >= 0.8);
        if (dupes.length) throw new ApiError(409, 'duplicate', 'This figure already has a very similar entry. Use add_update to extend it, or pass force:true if it is genuinely different.', dupes.map(e => ({ entryId: e.id, claim: e.claim })));
      }
      return submitDraft(agent, { title: f.name + ': new ' + entry.category, summary: args.summary || entry.claim,
        target: { mode: 'existing', figureId: f.id }, payload: { entries: [entry], flags: [] } });
    },

    async add_update(agent, args) {
      const S = await loadSchema();
      const f = await getFigure(args.figureId);
      const entry = (f.entries || []).find(e => e.id === args.entryId);
      if (!entry) throw new ApiError(404, 'not_found', 'No entry "' + args.entryId + '" on this figure. Use get_figure to list entry ids.');
      if (!args.update || typeof args.update !== 'object') throw new ApiError(400, 'invalid_argument', 'update is required.');
      const clash = (await pendingDrafts()).find(d => d.target && d.target.replaceEntryId === entry.id);
      if (clash) throw new ApiError(409, 'conflict', 'Another change to this entry is already waiting for review. Wait until it is approved or rejected, then try again.', { draftId: clash.id });
      const updated = { ...entry, updates: [...(entry.updates || []), args.update] };
      const v = requireValid(S.validateAdditions({ entries: [updated] }, f.id, { requireSources: true }));
      return submitDraft(agent, { title: f.name + ': update to ' + entry.category, summary: args.summary || (args.update.label || 'New update') + ' — ' + entry.claim,
        target: { mode: 'existing', figureId: f.id, replaceEntryId: entry.id }, payload: { entries: [{ ...v.entries[0], id: entry.id }], flags: [] } });
    },

    async propose_flag(agent, args) {
      const S = await loadSchema();
      const f = await getFigure(args.figureId);
      if (!args.flag || typeof args.flag !== 'object') throw new ApiError(400, 'invalid_argument', 'flag is required.');
      const v = requireValid(S.validateAdditions({ flags: [{ ...args.flag, figureId: f.id }] }, f.id, { requireSources: true }));
      return submitDraft(agent, { title: f.name + ': doublethink flag', summary: args.summary || v.flags[0].publishSentence,
        target: { mode: 'existing', figureId: f.id }, payload: { entries: [], flags: v.flags } });
    },

    async list_my_drafts(agent) {
      const subs = await db.collection('agentKeys/' + agent.hash + '/submissions').orderBy('created', 'desc').limit(25).get();
      if (subs.empty) return { drafts: [] };
      const live = await db.getAll(...subs.docs.map(d => db.doc('drafts/' + d.id)));
      const pending = new Set(live.filter(s => s.exists && (s.data().status || 'pending') === 'pending').map(s => s.id));
      return { note: 'Reviewers delete drafts when they approve or reject them, so "resolved" means one of the two. Check get_figure to see whether it was published.',
        drafts: subs.docs.map(d => ({ draftId: d.id, ...d.data(), status: pending.has(d.id) ? 'pending' : 'resolved',
          stage: pending.has(d.id) ? (live.find(s => s.id === d.id).data().stage || 'submitted') : undefined })) };
    },

    async get_draft(agent, args) {
      if (!args.draftId) throw new ApiError(400, 'invalid_argument', 'draftId is required.');
      const snap = await db.doc('drafts/' + String(args.draftId)).get();
      if (!snap.exists || snap.data().agentKeyId !== agent.hash) throw new ApiError(404, 'not_found', 'No pending draft with that id from this key (it may already be approved or rejected).');
      const d = snap.data();
      return { draftId: snap.id, title: d.title, summary: d.summary, status: d.status, stage: d.stage, target: d.target, payload: d.payload, created: d.created };
    },
  };

  // ---- HTTP handler ----------------------------------------------------------

  return async function handle(req, res) {
    res.set('Cache-Control', 'no-store');
    const send = (status, body) => res.status(status).json(body);
    try {
      if (req.method === 'GET') return send(200, { ok: true, result: await commands.help() });
      if (req.method !== 'POST') throw new ApiError(405, 'method_not_allowed', 'Use POST.');
      if ((req.rawBody ? req.rawBody.length : 0) > MAX_BODY_BYTES) throw new ApiError(413, 'too_large', 'Request body exceeds 100 KB.');
      const body = req.body && typeof req.body === 'object' ? req.body : {};
      const name = String(body.command || '');
      const fn = Object.prototype.hasOwnProperty.call(commands, name) ? commands[name] : null;
      if (!fn) throw new ApiError(400, 'unknown_command', 'Unknown command "' + name + '". Send {"command":"help"} for the list.');
      const agent = await authenticate(req);
      const args = body.args && typeof body.args === 'object' ? body.args : {};
      return send(200, { ok: true, result: await fn(agent, args) });
    } catch (e) {
      if (e instanceof ApiError) return send(e.status, { ok: false, error: { code: e.code, message: e.message, details: e.details } });
      console.error('agentApi error', e);
      return send(500, { ok: false, error: { code: 'internal', message: 'Something went wrong on the server.' } });
    }
  };
}

module.exports = { createAgentApi, hashKey, newKey, DEFAULT_DAILY_WRITES };

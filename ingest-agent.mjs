// Doublethink ingestion agent — write researched figures/entries/flags into the
// review queue (the `drafts` collection). NOTHING here goes public; a human
// approves each draft in the admin portal first.
//
// This uses the Firebase Admin SDK, which bypasses Firestore security rules, so
// keep the service-account key secret and run this only in a trusted backend.
//
// Setup:
//   1. Google Cloud console → IAM & Admin → Service Accounts → the Firebase
//      Admin SDK account → Keys → Add key → JSON. Save as service-account.json.
//   2. npm init -y && npm install firebase-admin
//   3. Copy schema.js (from the app) next to this file.
//   4. node ingest-agent.mjs   (runs the demo payload below)
//
// In production, an LLM produces the `payload` object; this file's job is to
// VALIDATE it against the shared contract and enqueue it. Invalid payloads are
// rejected here and never reach the queue.

import { initializeApp, cert } from 'firebase-admin/app';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import { readFile } from 'node:fs/promises';
import * as Schema from './schema.js';

const serviceAccount = JSON.parse(await readFile('./service-account.json', 'utf8'));
initializeApp({ credential: cert(serviceAccount) });
const db = getFirestore();

// Enqueue one draft. `input` is:
//   { title, summary, target: {mode:'new'} | {mode:'existing', figureId},
//     payload: { figure?, entries?, flags? } }
// Returns the created draft id. Throws if the payload fails the contract.
export async function enqueueDraft(input) {
  const target = input.target || { mode: 'new' };
  const res = Schema.validatePayload(input.payload || {}, { requireSources: true });
  if (!res.ok) {
    throw new Error('Draft rejected, does not meet the data contract:\n  - ' + res.errors.join('\n  - '));
  }
  if (target.mode === 'existing' && !target.figureId) throw new Error('target.mode "existing" needs a figureId.');
  if (target.mode !== 'existing' && !res.value.figure.name) throw new Error('A new-figure draft needs figure.name.');

  const draft = {
    source: 'agent',
    status: 'pending',
    title: input.title || res.value.figure.name || 'Untitled draft',
    summary: input.summary || '',
    target,
    payload: res.value,           // normalized, contract-clean
    schemaVersion: Schema.SCHEMA_VERSION,
    createdAt: FieldValue.serverTimestamp(),
  };
  const ref = await db.collection('drafts').add(draft);
  console.log('Enqueued draft ' + ref.id + ' (' + draft.title + ') for review.');
  return ref.id;
}

// ---- Demo run ---------------------------------------------------------------
// Replace this with real LLM output in production.
if (import.meta.url === `file://${process.argv[1]}`) {
  const src = (kind, label, outlet, url) => ({ kind, label, outlet, url });
  await enqueueDraft({
    title: 'Gov. Helena Ruiz',
    summary: 'New figure, one promise kept and one reversed claim, drafted from public record.',
    target: { mode: 'new' },
    payload: {
      figure: { name: 'Gov. Helena Ruiz', role: 'Governor', country: 'United States', state: 'Arizona', city: 'Phoenix', birth: '1970-02-11',
        milestones: [{ date: '2020-11-03', label: 'Elected Governor' }] },
      entries: [
        { category: 'promise', type: 'promise', tags: ['Water'], claim: 'I will not approve new golf-course water permits during the drought.', context: '2020 campaign pledge.',
          updates: [
            { date: '2020-09-01', status: 'pending', label: 'Promise made', note: 'Campaign platform.', sources: [src('article', 'Platform release', 'Desert Wire', 'https://example.com/platform')] },
            { date: '2023-05-15', status: 'kept', label: 'Upheld', note: 'Vetoed a permit-expansion bill.', sources: [src('transcript', 'Veto message', 'State Record', 'https://example.com/veto')] }
          ] },
        { category: 'claim', type: 'statement', tags: ['Ethics'], claim: 'No member of my family has ever lobbied the state.', context: '',
          updates: [
            { date: '2021-03-10', status: 'held', label: 'Claim made', note: 'Said in a press briefing.', sources: [src('video', 'Press briefing', 'Public Record TV', 'https://example.com/brief')] },
            { date: '2024-01-22', status: 'reversed_unack', label: 'Contradicted by filings', note: 'Lobbying registry lists a sibling in 2022.', sources: [src('article', 'Lobbying registry', 'Desert Wire', 'https://example.com/registry')] }
          ] }
      ],
      flags: []
    }
  }).catch(err => { console.error(err.message); process.exit(1); });
}

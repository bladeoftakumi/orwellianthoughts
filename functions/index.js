// Doublethink Cloud Functions — admin account management.
// The client SDK cannot mint or delete other users, so these callable functions
// run the Admin SDK server-side. Every function verifies the CALLER is the main
// administrator (their users/{uid} doc has role === 'main') before doing anything.
//
// Deploy:
//   cd functions && npm install
//   firebase deploy --only functions
//
// Requires the Blaze plan (outbound + Admin SDK), which the project is on.

const crypto = require('crypto');
const { onCall, onRequest, HttpsError } = require('firebase-functions/v2/https');
const { initializeApp } = require('firebase-admin/app');
const { getAuth } = require('firebase-admin/auth');
const { getFirestore } = require('firebase-admin/firestore');

initializeApp();
const auth = getAuth();
const db = getFirestore();
const { createAgentApi, hashKey, newKey, DEFAULT_DAILY_WRITES } = require('./agent-api');

async function requireMainAdmin(request) {
  const uid = request.auth && request.auth.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Sign in first.');
  const snap = await db.doc('users/' + uid).get();
  if (!snap.exists || snap.data().role !== 'main') {
    throw new HttpsError('permission-denied', 'Only the main administrator can manage editors.');
  }
  return uid;
}

// Editors sign in with a username; Firebase Auth still needs an email, so we
// synthesize one on this reserved internal domain. Editors never see or use it.
const EDITOR_DOMAIN = 'editors.orwellianthoughts.com';

function genPassword() {
  const cs = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  let out = '';
  for (let i = 0; i < 14; i++) out += cs[crypto.randomInt(cs.length)];
  return out.slice(0, 4) + '-' + out.slice(4, 9) + '-' + out.slice(9, 14);
}

// Create a new editor (role 'sub'). Returns a one-time temporary password for
// the main admin to hand over; the editor should change it after first sign-in.
exports.createEditor = onCall(async (request) => {
  await requireMainAdmin(request);
  const name = String((request.data && request.data.name) || '').trim();
  const username = String((request.data && request.data.username) || '').trim().toLowerCase();
  if (!name) throw new HttpsError('invalid-argument', 'A name is required.');
  if (!/^[a-z0-9._-]{3,32}$/.test(username)) throw new HttpsError('invalid-argument', 'Username must be 3-32 characters using letters, numbers, dots, underscores, or hyphens (no @).');
  const role = String((request.data && request.data.role) || 'sub').trim();
  if (role !== 'sub' && role !== 'agent' && role !== 'alead') throw new HttpsError('invalid-argument', 'Role must be an editor, an agent admin, or an agent.');
  const email = username + '@' + EDITOR_DOMAIN;

  const password = genPassword();
  let user;
  try {
    user = await auth.createUser({ email, password, displayName: name });
  } catch (e) {
    if (e.code === 'auth/email-already-exists') throw new HttpsError('already-exists', 'An account with that username already exists.');
    throw new HttpsError('internal', e.message || 'Could not create the account.');
  }
  await db.doc('users/' + user.uid).set({
    name, username, email, role, status: 'active', created: Date.now(),
  });
  return { uid: user.uid, username, email, password, role };
});

// Reset an editor's password. Returns a fresh temporary password.
exports.resetEditorPassword = onCall(async (request) => {
  await requireMainAdmin(request);
  const uid = String((request.data && request.data.uid) || '');
  if (!uid) throw new HttpsError('invalid-argument', 'Missing user id.');
  const doc = await db.doc('users/' + uid).get();
  if (!doc.exists) throw new HttpsError('not-found', 'That editor was not found.');
  if (doc.data().role === 'main') throw new HttpsError('permission-denied', 'The main administrator resets their own password from Settings.');

  const password = genPassword();
  try {
    await auth.updateUser(uid, { password });
  } catch (e) {
    throw new HttpsError('internal', e.message || 'Could not reset the password.');
  }
  return { uid, password };
});

// Delete an editor: removes the auth account and the users doc.
exports.deleteEditor = onCall(async (request) => {
  await requireMainAdmin(request);
  const uid = String((request.data && request.data.uid) || '');
  if (!uid) throw new HttpsError('invalid-argument', 'Missing user id.');
  const doc = await db.doc('users/' + uid).get();
  if (doc.exists && doc.data().role === 'main') throw new HttpsError('permission-denied', 'The main administrator cannot be deleted.');

  try { await auth.deleteUser(uid); } catch (e) { /* account may already be gone */ }
  await db.doc('users/' + uid).delete();
  return { uid, deleted: true };
});

// ---- Agent API --------------------------------------------------------------
// HTTP endpoint research agents call with a per-agent key. Agents can read the
// public record and submit drafts to the review queue; they cannot publish.
// maxInstances caps the worst-case cost if a key is abused.
exports.agentApi = onRequest({ cors: false, maxInstances: 3, memory: '256MiB', timeoutSeconds: 30 }, createAgentApi(db));

// Create an agent key. The plaintext key is returned ONCE; only its SHA-256
// hash is stored, so a database leak does not leak usable keys.
exports.createAgentKey = onCall(async (request) => {
  const uid = await requireMainAdmin(request);
  const name = String((request.data && request.data.name) || '').trim().slice(0, 60);
  if (!name) throw new HttpsError('invalid-argument', 'Give the agent a name.');
  const lim = parseInt(request.data && request.data.dailyLimit, 10);
  const dailyLimit = Number.isFinite(lim) && lim > 0 ? Math.min(lim, 1000) : DEFAULT_DAILY_WRITES;
  const key = newKey();
  const id = hashKey(key);
  await db.doc('agentKeys/' + id).set({ name, dailyLimit, active: true, last4: key.slice(-4), created: Date.now(), createdBy: uid, day: '', writesToday: 0, lastUsed: 0 });
  return { id, key, name, dailyLimit };
});

exports.listAgentKeys = onCall(async (request) => {
  await requireMainAdmin(request);
  const snap = await db.collection('agentKeys').orderBy('created', 'desc').get();
  const day = new Date().toISOString().slice(0, 10);
  return { keys: snap.docs.map(d => { const k = d.data(); return { id: d.id, name: k.name, last4: k.last4, active: k.active === true, dailyLimit: k.dailyLimit,
    draftsToday: k.day === day ? (k.writesToday || 0) : 0, created: k.created, lastUsed: k.lastUsed || 0 }; }) };
});

// Revoke a key. Takes effect within about a minute (keys are cached briefly).
exports.revokeAgentKey = onCall(async (request) => {
  await requireMainAdmin(request);
  const id = String((request.data && request.data.id) || '');
  if (!/^[a-f0-9]{64}$/.test(id)) throw new HttpsError('invalid-argument', 'Missing key id.');
  const ref = db.doc('agentKeys/' + id);
  if (!(await ref.get()).exists) throw new HttpsError('not-found', 'That key was not found.');
  await ref.update({ active: false, revokedAt: Date.now() });
  return { id, revoked: true };
});

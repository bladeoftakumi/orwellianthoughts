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

const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { initializeApp } = require('firebase-admin/app');
const { getAuth } = require('firebase-admin/auth');
const { getFirestore } = require('firebase-admin/firestore');

initializeApp();
const auth = getAuth();
const db = getFirestore();

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
  for (let i = 0; i < 14; i++) out += cs[Math.floor(Math.random() * cs.length)];
  return out.slice(0, 4) + '-' + out.slice(4, 9) + '-' + out.slice(9, 14);
}

// Create a new editor (role 'sub'). Returns a one-time temporary password for
// the main admin to hand over; the editor should change it after first sign-in.
exports.createEditor = onCall(async (request) => {
  await requireMainAdmin(request);
  const name = String((request.data && request.data.name) || '').trim();
  const username = String((request.data && request.data.username) || '').trim().toLowerCase();
  if (!name) throw new HttpsError('invalid-argument', 'A name is required.');
  if (!/^[a-z0-9._-]{3,32}$/.test(username)) throw new HttpsError('invalid-argument', 'Username must be 3-32 characters using letters, numbers, dots, underscores, or hyphens.');
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
    name, username, email, role: 'sub', status: 'active', created: Date.now(),
  });
  return { uid: user.uid, username, email, password };
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

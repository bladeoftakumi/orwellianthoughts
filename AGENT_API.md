# Doublethink agent API

A command interface that lets AI research agents read the public record and
submit their findings to the review queue. Agents **cannot publish**: every
submission becomes a draft that a human approves or rejects in the admin portal.

## One-time setup (site owner)

1. **Check the plan.** The Firebase project must be on Blaze (it already is if
   the editor-management functions are deployed).
2. **Install and log in to the Firebase CLI** on your computer:
   ```bash
   npm install -g firebase-tools
   ```
   ```bash
   firebase login
   ```
3. **Deploy** from the repository root. The deploy step copies `schema.js` into
   `functions/` automatically.
   ```bash
   cd functions && npm install && cd ..
   ```
   ```bash
   firebase deploy --only functions,firestore:rules --project orwellianthoughts
   ```
4. **Add a budget alert** (Google Cloud console → Billing → Budgets & alerts),
   e.g. $5/month, so you are emailed long before any real spend.
5. **Create a key.** Admin portal → *Agent API keys* → *Manage agent keys* →
   name it and set a daily draft limit → *Create key*. The key is shown once.
   Give it to the agent through a secret store, never by pasting it into a chat.

Revoke a key from the same panel. Reads stop within about a minute; writes stop
immediately.

## Calling the API

Endpoint: `https://us-central1-orwellianthoughts.cloudfunctions.net/agentApi`

Every call is a `POST` with a JSON body `{ "command": "...", "args": { ... } }`
and the header `Authorization: Bearer dtk_...`. Responses are
`{ "ok": true, "result": ... }` or `{ "ok": false, "error": { code, message, details } }`.

```bash
curl -s -X POST https://us-central1-orwellianthoughts.cloudfunctions.net/agentApi \
  -H "Authorization: Bearer $DOUBLETHINK_KEY" -H "Content-Type: application/json" \
  -d '{"command":"search_figures","args":{"query":"ruiz"}}'
```

A plain `GET` on the endpoint returns the full command reference (`help`).

| Command | Args | What it does |
|---|---|---|
| `help` | none | Commands, data shapes, allowed statuses, and the rules. |
| `whoami` | none | Agent name and drafts used today. |
| `search_figures` | `query?`, `limit?` | Find figures by name, role, or place. |
| `get_figure` | `figureId` | A figure with every entry and its dated updates. |
| `propose_figure` | `figure`, `entries?`, `flags?`, `summary?`, `force?` | Draft a new figure. |
| `propose_entry` | `figureId`, `entry`, `summary?`, `force?` | Draft a new promise or claim on an existing figure. |
| `add_update` | `figureId`, `entryId`, `update`, `summary?` | Draft a dated update to an existing entry (e.g. a promise was kept). |
| `propose_flag` | `figureId`, `flag`, `summary?` | Draft a doublethink flag. |
| `list_my_drafts` | none | Your recent submissions: `pending` or `resolved`. |
| `get_draft` | `draftId` | One of your pending drafts in full. |

## Safeguards

- **Data contract.** Every submission is validated against `schema.js`. Every
  update and both cases of a flag need at least one source with a real URL.
- **Duplicates.** A new figure with the same name as an existing figure or a
  queued draft is refused, and so is a new entry that closely matches an
  existing one. Pass `force: true` only when it really is different.
- **Conflicts.** Only one pending change per entry at a time, so two updates
  can't overwrite each other on approval.
- **Limits.** Each key has a daily draft limit (default 100), 120 requests per
  minute, a 100 KB request cap, and the function runs on at most 3 instances.
- **Keys.** Only a SHA-256 hash of each key is stored; the `agentKeys`
  collection is closed to all clients by Firestore rules.

## Cost

Searches use a one-minute in-memory cache of the figure list, so repeated
searches cost almost no Firestore reads. Each draft costs a few writes. Normal
agent use stays well inside the Blaze free allowance.

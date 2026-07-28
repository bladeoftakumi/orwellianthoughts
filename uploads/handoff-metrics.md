# Doublethink: metrics model

Replaces the current single score. Two scores and one flag.

| | What it answers | Type |
|---|---|---|
| Reliability | Do they do what they said? | Rate |
| Consistency | Do they keep a coherent account of what they said? | Rate |
| Doublethink | Do they judge the same conduct differently depending on who did it? | Count |

Scores are automated from entry statuses. Flags are human reviewed only and are never derived from statuses.

---

## 1. Reliability

Tracks promises. Statuses unchanged: Kept, Broken, Partial, Under review.

```
resolved = entries where status != pending
reliability = (kept + partial * 0.25) / resolved * 100
```

Three fixes to the current implementation:

1. **Remove the doublethink penalty.** Delete `- flags * 20` from the calculation. Flags no longer touch any score.
2. **No score when nothing is resolved.** Currently `resolved <= 0` returns 100, so a figure with only pending entries displays a perfect score. Return null instead and render "Not enough data" in place of the number.
3. **Remove the zero floor.** With the penalty gone, the value cannot go below zero on its own, so `Math.max(0, ...)` is no longer needed.

Partial staying at 0.25 is an editorial choice, not a neutral one. It places a partial delivery closer to broken than kept. Worth a line on the About page stating why.

---

## 2. Consistency (new)

Tracks claims of fact, not promises. A consistency entry anchors on a statement the figure made about their own position or record, then records how it held up.

**Statuses and weights:**

| Status | Meaning | Weight |
|---|---|---|
| Held | Claim checks out against the record | 1.0 |
| Reversed, acknowledged | Position changed, said so publicly | 0.9 |
| Reversed, unacknowledged | Position changed, never addressed | 0.25 |
| Denied | Asserts they never held the old position | 0 |
| Under review | Logged, outcome pending | excluded |

```
resolved = entries where status != pending
consistency = sum(weights) / resolved * 100
```

Two things this design depends on:

**Held must be logged.** If contributors only submit failures, every consistency score is zero and the metric is dead. Verified claims that hold up have to be entries in their own right. This needs saying explicitly in the submission guidelines.

**The gap between the middle two statuses is the point.** Acknowledging a change costs almost nothing. Staying silent costs most of the point. That asymmetry is deliberate and should be visible to the reader.

No negative weights. Denied scores zero and no lower, so the score keeps distinguishing between figures instead of everyone bottoming out.

---

## 3. Doublethink flag

**A count, not a rate. Never computed. Only published after human review.**

Delete the existing derived rule entirely:

```js
flagged: ups.length >= 2 && last && last.status === 'broken'
```

It fires on ordinary broken promises and misses actual contradictions. It has no replacement in code.

### Criterion

> Similar actions in similar circumstances, opposite moral judgment.

Two variants:

- **Applied to others.** Same conduct by two groups, one praised, one condemned.
- **Applied to self.** Demanded consequences for others, sought exemption for their own side.

A broken promise is never a flag. Neither is a misremembered statement, which is a consistency failure and lands on that score.

### Conditions, all required

1. Two records, each sourced, each attributable to the figure. Their own words, or a formal act (vote, signature, filing, order).
2. The conduct being judged is materially similar across both cases.
3. The moral judgments are opposite.
4. The figure has not publicly reconciled the two positions.

### Publish test

The entry does not ship unless this sentence completes cleanly:

> On *[date]*, X judged **[action]** by **[actor A]** as **[verdict]**. On *[date]*, X judged the same action by **[actor B]** as **[opposite verdict]**. Similar on: *[named axes]*.

If it takes a paragraph to explain why the cases are alike, they are not alike enough.

### Data shape

The flag is its own object, not a property of an entry. It needs to reference two cases that may sit under different figures.

```
flag {
  id
  figureId          // whose double standard this is
  caseA { date, actorJudged, action, verdict, sources[] }
  caseB { date, actorJudged, action, verdict, sources[] }
  similarityAxes[]  // conduct, scale, role, legality, etc.
  subjectDistinction // their own argument for why the cases differ, or "never addressed"
  publishSentence
  reviewedBy, reviewedAt
}
```

`subjectDistinction` is not optional. If the figure has argued the cases differ, that argument gets published inside the flag. The reader draws the conclusion.

---

## Display rules

**Every score shows its denominator.** A consistency of 60 across five claims and across ninety claims are different statements and must not render identically.

```
Reliability   72   ·  18 resolved
Consistency   84   ·  31 resolved
Doublethink    2 flags
```

The three signals sit together on the figure page so a reader can weigh them. One flag against a long clean record reads differently than one flag against a thin one. That calibration is the product, so do not present any of the three in isolation.

**Denials get a visible count** next to the consistency score even though they carry no flag. They are serious and a rate alone softens them.

**Retire the current 0 to 100 bar coloring** at the 80 threshold, or apply it to both scores consistently.

---

## About page copy

Existing reliability section stays, minus the doublethink penalty paragraph.

Add:

> **Consistency** asks a different question: do they keep a coherent account of what they said? A claim that holds up against the record scores full marks. Changing position and saying so plainly costs almost nothing. Changing position in silence costs most of the point. Claiming you never held the old position scores zero.

> A **doublethink flag** is not a broken promise and not a faulty memory. It records something narrower: the same conduct judged one way when an opponent does it and the opposite way when an ally does. Every flag names both cases, dates them, links their sources, and publishes the figure's own explanation of why the cases differ if they have given one. The contradiction is yours to weigh, not ours to assert.

> Flags are reviewed by hand and stay rare. Read them next to the two scores. A single flag against a long consistent record means something different from a pattern.

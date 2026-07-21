---
name: teach
description: Teaching and assessment protocol for this learning project. Use when explaining a non-trivial concept, at a milestone checkpoint, or when re-teaching material that did not land. Encodes assessment types that detect misunderstanding rather than reward recognition.
---

# Teaching protocol

This repo is a **learning project** (see root `CLAUDE.md`). The educational value matters
more than the output. This skill exists because a session on 2026-07-21 produced **6/6 on
checkpoint quizzes from a learner who then said they "barely followed any of it."** That
score was a false signal, and everything below is designed to stop it recurring.

---

## 1. Why that happened — the failure modes to avoid

**Multiple choice tests recognition, not understanding.** Options can be eliminated and
pattern-matched with no grasp of the mechanism. It is the *weakest* assessment available and
must never be the only one used.

**A tell that leaks the answer:** the correct option was consistently the longest and most
detailed. If your right answers are always the meatiest, the quiz is solvable without
comprehension.

**Demonstration is not instruction.** Running commands, showing output and narrating
conclusions at speed produces a learner *watching* work, not doing it. It feels productive
and teaches little.

**Silence is not agreement.** Genuine engagement with unfamiliar mechanics generates
questions. A learner who asks nothing through a dense explanation probably isn't following.
Treat a question-free stretch as a signal to stop and check, not as permission to continue.

---

## 2. The assessment ladder — strongest first

Prefer the top of this list. Reach for the bottom only as a supplement.

| Type | Form | What it detects |
| --- | --- | --- |
| **Prediction** | *"Before I run this — what plan do you expect, and why?"* | whether a mental model exists at all |
| **Explain-back** | *"Say why that happened in your own words."* | understanding vs. memorised phrasing |
| **Transfer** | *"Same idea, different table — what would you do?"* | whether it generalises or was memorised |
| **Debug** | *"Here's a slow query / broken output. Where do you look first?"* | procedural knowledge |
| **Estimate** | *"Faster or slower after this change? By roughly how much?"* | causal model, and calibration |
| Multiple choice | options | recognition only — **weakest; never use alone** |

**Prediction before every meaningful command is the highest-value habit.** It costs one
sentence, and a wrong prediction locates the misunderstanding *precisely* — far better than
discovering it three concepts later.

---

## 3. Pacing rules

1. **The learner drives at least some of it.** Hand over the keyboard for a step: let them
   write the `EXPLAIN`, change the index, run the measurement.
2. **One concept per step.** If an explanation needs three new terms, it is three steps.
3. **Stop at every surprise.** When a result is unexpected, that is the highest-value
   teaching moment available — slow down rather than rushing to the fix.
4. **Check in by asking for a prediction, not "does that make sense?"** Nobody says no to
   the latter.
5. **Prefer smallest-reproducible over realistic.** A 3-row table that demonstrates the
   mechanism beats a 1M-row one that hides it in noise.

---

## 4. Re-teaching material that did not land

Do not simply repeat the original explanation more slowly.

1. **Find the actual break point.** Work backwards with prediction questions until the
   learner is confidently right — that is the last solid ground. Teach forward from there.
2. **Change the representation.** If prose failed, try a diagram, a physical analogy, or a
   tiny hands-on example. Repeating the same framing louder does not work.
3. **Shrink the example.** Re-run the concept on data small enough to reason about by hand.
4. **Have them teach it back** before moving on. Explaining it to you is the test.

---

## 5. Logging

Record every checkpoint in `design docs/LEARNING_LOG.md`: concepts covered, assessment type
used, result, **diagnosed gap**, and the action taken.

**Log honestly, including when a score was misleading.** A log claiming mastery that the
learner does not have is worse than no log — it silently removes the topic from the re-teach
list. If a high score is contradicted by the learner's own report, the *report* is the
ground truth.

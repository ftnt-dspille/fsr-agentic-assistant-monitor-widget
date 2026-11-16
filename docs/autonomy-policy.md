# The autonomy policy: letting the assistant act on its own

This is for the SOC lead who decides how much the assistant may do without a
person in the loop. It explains, in plain terms, what the policy is, how to read
the Autonomy tab, and how to turn a rule on safely.

You set all of this on the **Autonomy** tab of the Agentic Assistant Monitor. Saving
needs a reviewer role.

## First, the one distinction that matters

There are two separate things, and it is easy to mix them up:

- **Investigating** is the assistant looking at an alert and reaching a verdict
  ("this is a false positive", "this is a real threat"). Investigating never
  changes anything. Turning on auto-triage, so the assistant investigates every
  new alert on its own, is safe: the worst it does is reach a wrong verdict,
  which a person still reviews.
- **Acting** is the assistant doing something because of that verdict, with no
  person: closing a false-positive alert, blocking an address. **Acting is what
  the policy controls.** The assistant never acts on its own unless a policy
  rule says it may.

So: auto-triage decides whether the assistant *investigates* unattended. The
policy decides what, if anything, it may *do* about what it found.

## What a rule is

A rule says: "when the verdict looks like *this*, the assistant may do *that*."
For example: *when the verdict is a false positive, at least 80% sure, and it
cites a successful lookup, close the alert.*

Each rule has three parts, shown in the same words on the tab:

- **Action** -- what it may do. Today: close the record, or block an IP.
- **When** -- the verdict that has to hold first: which dispositions (false
  positive, benign, suspicious, true positive), a minimum confidence, and
  optionally that the verdict **cites a successful lookup** (so the assistant
  cannot close an alert on the alert's own text alone -- it must have actually
  checked something).
- **Limits** -- an optional cap, such as no more than 20 closes an hour.

A close only ever sets the alert's status to **Closed** (and, if you allow it, a
resolution or a closure note). It never changes the owner, the severity, the
type, or anything else on its own. A rule that would touch one of those is left
for a person.

## Shadow and enforce

Every policy is in one of two modes:

- **Shadow** -- the assistant records what it *would* have done, and does
  nothing. This is where every rule should start. You get a table of "would it
  have been right?" without any risk.
- **Enforce** -- the assistant actually does it, unattended.

There is also a **kill switch** at the top: set it to **Off** and nothing acts,
whatever the rules say. **Armed** means the rules are live (in whichever mode the
policy is in).

When you turn auto-triage on, a starter rule is dropped in for you -- *close a
false positive* -- **in shadow**. From day one you can see, on the tab, whether
that close would have been right, while nothing is actually closed.

## Reading the shadow table before you enforce

The tab shows, per rule, how often it **would have run** and whether the person
who saw the same alert **agreed**. The column that matters is **"would run it,
rejected"**: a time the rule would have acted, but a human disagreed. That is the
one disagreement that should stop you enforcing.

The bar before you promote a rule to enforce: **two weeks with no "would run it,
rejected."** If the rule keeps wanting to act where people say no, it is not
ready, and the table tells you exactly which alerts to look at.

## Undo

Anything the policy closes can be reopened. The Monitor keeps what the alert
looked like before, and an **Undo** puts it back with its prior values. Nothing
the assistant does on its own is one-way.

## A worked example, start to finish

1. **Turn on auto-triage** for your alerts. A *close false positive* rule appears
   on the Autonomy tab, in **shadow**.
2. **Leave it in shadow and watch.** For the next couple of weeks the table fills
   in: each new alert the assistant judged a false positive shows up as "would
   have closed it", next to what the on-call analyst actually did.
3. **Read the "would run it, rejected" column.** If it stays empty -- the
   assistant and your analysts agreed every time -- the rule is trustworthy. If
   not, open those alerts and see why; adjust the rule (raise the confidence
   floor, require a lookup) and keep watching.
4. **Promote to enforce.** Switch the policy to enforce and save. Now a
   clean-looking false positive is closed on its own, with a note on the alert
   saying why and how to reopen it.
5. **If one was wrong,** use **Undo** on the Monitor: the alert reopens with
   everything it had before.

## Tuning a rule

Tuning is just editing the rule. If the assistant is closing things it should
not, raise the **confidence** it needs, or require that it **cites a successful
lookup**. If it is too cautious and leaving easy false positives for a person,
lower the confidence a little. The shadow table is how you check a change before
it acts: make the edit, leave it in shadow, and watch the "would run it,
rejected" column again.

## If something looks wrong

- **Set the kill switch to Off.** Everything stops acting immediately; the rules
  and the shadow record stay, so you lose nothing.
- The policy is read fresh every time, so turning the kill switch off takes
  effect within seconds.

---

Hosts in any example here are placeholders (for example `fortisoar.example.com`);
use your own.

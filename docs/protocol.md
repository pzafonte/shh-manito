# 쉿! 마니또 protocol

Version 1. This document specifies how a round runs and records what was found
when the first draft was attacked. Nobody independent has reviewed it.

The goal is one sentence: **nobody learns who drew whom before reveal day, and
that includes the person running the server.** Section 9 lists every way this
draft was broken and how each break was fixed. `docs/threat-model.md` states what
is and is not protected, in plainer terms.

## 1. Parties and assumptions

- **Players.** 4 to 30. Each runs the same client code on a phone.
- **Organiser.** A player with three extra powers: lock the roster, confirm the
  check words, remove a player. No power over the circle.
- **Server.** Stores and serves a log. Treated as hostile: it may read everything
  it stores, drop, delay, reorder, replay or forge entries, show different clients
  different logs, and collude with players.
- **Assumed honest:** the code the browser runs (section 10), the browser's
  WebCrypto, and the phone itself.

Two invariants carry most of the weight, so they are stated once here.

**I1. One peel.** A client removes a layer from at most one list per attempt, and
never holds the layer's private key after doing so.

**I2. Silence.** Everything a client does on the network is a function of public
log state and of what its user taps. Nothing a client *privately learns* (that a
parcel opened, that a parcel did not open, who it drew) may change when it polls,
what it posts, or when it posts, except on a path that destroys the attempt.

## 2. Primitives

All from WebCrypto.

| Use | Primitive |
| --- | --- |
| Signatures | ECDSA P-256 with SHA-256, 64-byte `r‖s` |
| Key agreement | ECDH P-256, public keys 65 bytes uncompressed |
| Key derivation | HKDF-SHA-256 |
| Encryption | AES-256-GCM, 12-byte random IV |
| Hashing | SHA-256 |

`H(label, a, b, …)` is SHA-256 over `"shh-manito/v1/" + label`, then each part
prefixed by its 4-byte big-endian length. Parts are bytes or UTF-8 strings.
Hashing is always over content, never over a signature, because an ECDSA
signature can be rewritten into a second valid one (finding F21).

`canon(value)` is JSON with object keys sorted. Values are only strings, safe
integers, booleans, arrays and objects.

A signature is `ECDSA(key, canon({ ctx, ...fields }))` where `ctx` is
`"shh-manito/v1/sig/<role>/<type>"` and `role` is `id` or `box`. Every signed
object contains `r` (the round id). Attempt-scoped objects also contain `a`, the
attempt number, so a signature made for one round, attempt, step or role cannot
verify as another.

## 3. Secrets and derived values

### Invite

The organiser's client generates `roundId` (16 random bytes) and `inviteSecret`
(32 random bytes). The link is `#join=<roundId>.<inviteSecret>`, base64url. The
fragment is never sent to the server.

```
authToken = HKDF(inviteSecret, salt="shh-manito/v1", info="auth-token|" + roundId, 32)
groupKey  = HKDF(inviteSecret, salt="shh-manito/v1", info="group-key|"  + roundId, 32)
```

The server stores `SHA-256(authToken)`. It sees `authToken` on every request, so
the token only gates spam. It is not a secret from the server, and it does not
reveal `groupKey`.

### Keys

| Key | Type | Lifetime | In backup? |
| --- | --- | --- | --- |
| Identity | ECDSA | The round | Yes |
| Mix | ECDH | One attempt, deleted after peeling | **Never** |
| Box | ECDH + ECDSA pair | One attempt | Yes |
| Seed | 32 random bytes | One attempt | Yes |
| Check nonce | 32 random bytes | One check version | Yes |

The identity key is signing only. The first draft also gave players a long-term
ECDH identity key for onion layers. That is gone (finding F3).

Private keys are non-extractable `CryptoKey`s in IndexedDB. Box and identity keys
are generated extractable, exported once into the encrypted keyring (section 8),
re-imported non-extractable, and the extractable handle is dropped.

`fingerprint(identityPub)` is the first 16 bytes of `H("fp", identityPub)`,
base64url. Players are referred to by fingerprint.

### Sealing

`seal(recipientPub, plaintext, purpose)`:

```
e      = fresh ECDH key pair
shared = ECDH(e.private, recipientPub)
key    = HKDF(shared, salt=H("seal-salt", e.public, recipientPub), info=purpose, 32)
iv     = 12 random bytes
output = e.public (65) ‖ iv (12) ‖ AES-GCM(key, iv, plaintext, ad=purpose)  (+16 tag)
```

The output carries no recipient label and adds exactly 93 bytes. `purpose` is
`"parcel|<roundId>"` for parcels and `"onion|<roundId>|<attempt>|<layer>"` for
onion layers, so a layer cannot open in a different round, attempt or position,
and a parcel can never be confused with a layer.

## 4. The log

The log is a list of entries. Clients treat it as untrusted input.

```
{ seq, kind: "group" | "sealed", body: bytes, visibleAt: ms | null }
```

**`group` entries** are encrypted under `groupKey`:

```
body = iv (12) ‖ AES-GCM(groupKey, iv, pad512(canon(event)), ad="group|" + roundId)
```

`pad512` is a 4-byte length, the content, then zeros up to a multiple of 512
bytes. Padding hides nickname length and most event types (finding F7).

**`sealed` entries** are one parcel: exactly 1,024 bytes of plaintext, 1,117
sealed.

**Delivery.** Every client downloads every entry and tries to open every sealed
entry with its current box key. The server learns that someone posted a parcel
and never learns who it is for.

**Held entries.** A sealed entry posted with `held: true` goes into a separate
table with `visible_at` set to the next mail time. When that time passes, the
server moves all due entries into the log **in random order, with fresh sequence
numbers**. It stores no time of posting. Send time is therefore not recoverable
from anything a player can see (finding F8).

**Folding.** `foldLog(entries, groupKey)` is a pure function of the entries. It
parses every group event, verifies signatures, and derives the round state. Two
clients with the same entries reach the same state. Conflicts inside a step
resolve to the first event in log order. Anything invalid is skipped; the fold
never throws on bad input. A client reads to the end of the log before it folds or
acts, because the start of a finished draw looks like a draw still running (finding
F25).

## 5. Round setup

### create

The first thing the organiser posts, signed by the organiser's identity key.

```
{ t:"create", r, name, revealAt, timeZone, mailTimes, budget, pub, sig }
```

The server stores its own copy of `revealAt`, `timeZone` and `mailTimes` so it can
schedule mail and deletion. Clients compare these with the signed values and show
a warning if they differ, so the server cannot silently move the reveal or the
post (finding F6).

### join

```
{ t:"join", r, nickname, sticker, pub, sig }
```

Self-signed by the joiner's identity key. Invalid after the 30th accepted join.
Nicknames are compared after NFKC and case folding; the first join wins and a
later duplicate is not accepted. The client then asks for another name.

### lock

Signed by the organiser.

```
{ t:"lock", r, members:[{ fp, join:H("join", canon(joinWithoutSig)) }, …], sig }
```

The list is the roster and its order. Only the first valid lock counts. Joins not
listed are ignored forever, so a late arrival can never enter.

`rosterHash = H("roster", canon(create without sig), canon(each listed join without sig) …)`

### Check words

Three words from a list of 256 give 24 bits, far too few to resist a server that
grinds a second roster until the words collide. So the words come from a
commit-then-reveal over everyone's fresh randomness, the same idea as a ZRTP short
authentication string (finding F5).

For check version `v` (the number of removals so far), each active player:

1. picks a fresh 32-byte nonce `n` and posts `{ t:"checkCommit", r, v, from, commit:H("check-commit", n), sig }`;
2. waits until **every** active player's commit for `v` is visible;
3. posts `{ t:"checkReveal", r, v, from, nonce:n, sig }`.

```
checkHash = H("check", rosterHash, v, removedFingerprints…, nonce₁, nonce₂, …)   (roster order)
words     = wordlist[checkHash[0]], wordlist[checkHash[1]], wordlist[checkHash[2]]
```

A reveal that does not match its commit is ignored, and the check stalls at that
player. People read the words aloud. The organiser taps "We all match":

```
{ t:"match", r, checkHash, sig }
```

A client that computes a different `checkHash` rejects the `match` and stops
there. A player whose words differ can tap "Mine are different", which stops their
phone taking part. The draw needs every player, so stopping one phone stops it.

### remove

Signed by the organiser. Allowed until an attempt is final and only while at least
4 players would remain.

```
{ t:"remove", r, index, target, a, sig }
```

`index` is the number of removals before this one, which gives removals a single
order. `a` is the attempt it applies to, or 0 during the check. A removal during
the check starts a new check version with fresh nonces. Once the words are agreed a
removal with `a` of 0 counts for nothing. A removal during attempt `a` ends that
attempt, unless the target already posted `ready` for it.

## 6. The draw

Attempt numbers start at 1. Attempt `t` begins once the round is matched and
attempt `t-1` is dead. `P` is the active roster in lock order, `n = |P|`. Steps run
automatically on each phone; nobody taps anything.

**Step 1: mix keys.** Each player generates a fresh mix key, a fresh box pair and
a fresh seed `s`, then posts:

```
{ t:"mixkey", r, a, from, mixPub, seedCommit:H("seed", s), sig }
```

**Step 2: onions.** Once all `n` mix keys are visible, each player builds a payload
of its two box public keys (130 bytes), seals it to `mixPub` of `P[n-1]`, then
`P[n-2]`, down to `P[0]`, and posts:

```
{ t:"onion", r, a, from, onion, sig }
```

An onion is `130 + 93n` bytes, and layer `k` uses purpose `onion|r|a|k`.

**Step 3: mixing.** `L₀` is the onions in roster order. For `k = 0 … n-1`, player
`P[k]`:

1. checks `L_k` has exactly `n` items, all of the expected length, no two equal;
2. removes layer `k` from every item, posting `abort` if any fails;
3. shuffles with Fisher-Yates over `crypto.getRandomValues`, rejecting biased draws;
4. stores the output, deletes its mix key, then posts:

```
{ t:"mix", r, a, from, k, input:H("list", L_k…), items:L_{k+1}, sig }
```

Storing before posting means a reload re-sends the same output instead of
shuffling again (invariant I1). A client with no mix key, such as one restored
from a personal link, cannot peel and posts `abort`.

The fold rejects an attempt whose `mix` event fails any public check: wrong input
hash, wrong item count, wrong length, or duplicates.

**Step 4: confirm.** `L_n` is `n` payloads. Every client checks publicly that no
ECDH key and no ECDSA key appears twice. Each player then checks its own payload
appears exactly once, **comparing both keys**, and posts:

```
{ t:"confirm", r, a, from, transcript, seed:s, sig }
```

```
transcript = H("transcript", rosterHash, a, mixPub₁, seedCommit₁, …, onion₁, …, L₁…, L₂…, …, L_n…)
```

If its payload is missing, it posts `abort` instead. A `confirm` with a different
transcript, or a seed that does not match its commit, kills the attempt.

**Step 5: the circle.** Once all `n` confirms are in:

```
seed       = H("circle-seed", s₁, s₂, …)   (roster order)
circle     = payloads sorted by H("circle-order", seed, ecdhPub)
circleHash = H("circle", a, seed, circle…)
```

`circle[i]` looks after `circle[i+1]`, wrapping round. A single cycle means nobody
draws themselves. Nothing any mixer did to the list's order survives this sort
(finding F1).

**Step 6: slips.** Each player finds its position `i`, builds a slip parcel, seals
it to `circle[i-1]`, and posts it inside a signed group event:

```
slip parcel: { t:"slip", r, a, circle:circleHash, fp, box:ecdsaPub, sigId, sigBox }
group event: { t:"slip", r, a, from, parcel, sig }
```

`sigId` is by the identity key and `sigBox` by the box key, both over the same
fields, so a name cannot be attached to a key by anyone but its owner.

**Step 7: ready.** A client waits until **all `n` slip events are visible**, and
does nothing different before then. It then opens the parcels with its box key. It
expects exactly one to open, with `sigBox` from `circle[i+1]` and `sigId` from a
roster member other than itself. If so:

```
{ t:"ready", r, a, from, slips:H("slips", circleHash, parcel₁, parcel₂, …), sig }
```

Otherwise it posts `abort`. A `ready` with a different `slips` hash kills the
attempt. When all `n` players have a valid `ready`, the attempt is **final**.
Nothing about it can change after that. The client shows a slip only once its
attempt is final.

**abort.** `{ t:"abort", r, a, from, why, sig }`. Any roster member, at any step.
For each player, whichever of `ready`, `abort` or being removed comes first in log
order decides; a later `abort` from someone who already posted `ready` is ignored.

A phone that sees an attempt die from a public fault posts `abort` for it too. If
the log is honest this is redundant. If the server showed only this phone a bad
entry, it is the only way the others find out (finding F24).

**Ending an attempt.** A dead attempt is thrown away whole. Each client deletes its
mix key, box keys and seed for that attempt, and starts attempt `t+1` with fresh
ones. After 4 failures not caused by a removal, the round stops retrying and the
organiser is offered a fresh round (finding F12).

## 7. Play

Parcels share one inner shape: a JSON object with `t`, `r`, `a`, an `id` of 16
random bytes where the type needs one, the type's fields, and `sig` by the sender's
box key. It is padded to 1,024 bytes, with a 2-byte length first, then sealed.

| Type | From → to | Fields | Held |
| --- | --- | --- | --- |
| `card` | giver → target | `card`, `amount` | Yes, before reveal |
| `thanks` | target → giver | `card` | No |
| `pay` | target → giver | `detail` | No |
| `waive` | target → giver | | No |
| `paid` | giver → target | | No |
| `got` | target → giver | | No |

A client accepts a parcel only if it opens under its own box key **and** `sig`
verifies under the one key allowed for that type: `circle[i-1]` for `card` and
`paid`, `circle[i+1]` for the others. Parcels are deduplicated by `id`, so a replayed
card cannot double a promise (finding F10).

`card` must name a card from the fixed list. `amount` is a canonical decimal string,
parsed as bigint, and cards that push the running total past the budget are dropped
by the receiver. `detail` must match a Lightning address or a BOLT 11 invoice shape,
checked by sender and receiver, so it cannot carry free text beyond what an address
can spell (finding F20).

Reading a parcel causes no network activity. Clients poll at a rate set only by the
public phase of the round: fast during the draw, slow afterwards.

**Reveal.** After `revealAt` a player may post:

```
{ t:"reveal", r, a, from, box:ecdsaPub, sigId, sigBox }
```

Both signatures are required. The fold places that player at the position of that
box key. Other positions stay unknown. The client hides reveals until `revealAt` on
its own clock. A modified client can reveal early, but it can only reveal itself.

**Play again.** A roster member may post `{ t:"rematch", r, from, link, sig }` with
a fresh invite link. The first valid one counts.

## 8. Personal link

`#me=<roundId>.<meSecret>` restores a player in any browser.

```
handle    = HKDF(meSecret, salt="shh-manito/v1", info="backup-handle|" + roundId, 32)
backupKey = HKDF(meSecret, salt="shh-manito/v1", info="backup-key|"    + roundId, 32)
blob      = iv ‖ AES-GCM(backupKey, iv, pad(state, 16,384 bytes), ad=handle)
```

The blob is always 16,412 bytes. The plaintext holds the invite secret, an encrypted
keyring and the state worth keeping: sent promises, the guess, settlement records.

The keyring holds the identity key, the current box pair and seed, encrypted under
`backupKey` when they are generated. Refreshing the backup copies the ciphertext, so
private keys never need to be extractable after generation. **It never holds a mix
key.**

The backup is refreshed when attempt keys are generated, when an attempt becomes
final, and after the player sends a parcel. It is never refreshed because something
*arrived* (invariant I2, finding F15). A changed guess rides along with the next
refresh rather than causing one, because guesses tend to change just after a card
lands.

A restored client folds the log, opens what it can with the box key, and carries on.
If it is mid-attempt and needs a mix key it does not have, it posts `abort`. The
attempt restarts, which is safe because nothing has been built on it yet.

`meSecret` stays in IndexedDB so the link can be shown again. This means script
running in the page could read it and recover keys, whatever `extractable` says
(finding F18). That risk is carried by the content security policy.

## 9. Findings

Each was found by attacking the first draft, before any code was written. Tests are
in `packages/protocol/src/attacks.test.ts` and `apps/server/test/` unless noted.

### Breaks of the main requirement

**F1. The last mixer chooses the circle.** The draft used the last mixer's output
order as the circle. That player sees plaintext keys and picks any order. They
cannot tell whose key is whose, but they know their friends' keys, so two colluders
can always place themselves one apart around a victim. One sees the victim as target,
the other is the victim's target, and together they know that victim's link. *Fix:*
the mix only decides the set of keys. Order comes from a hash of the keys under a seed
built from every player's commitment, published before the mix and opened after it.

**F2. Drop-and-watch finds any giver.** In the draft each player seals a name as a
sealed entry, and a client reacts when its slip does not arrive. An active server
holds back Alice's parcel, which it can identify by connection, and releases the
rest. Every phone finishes except Alice's giver, so the server learns the link. It
then releases the parcel and the attempt succeeds. Even a slower poll rate after
receiving a slip gives this away. This defeats the main requirement with no help from
any player. *Fix:* invariant I2. Slips are one attributable, publicly countable event
per player, so a phone can tell that all `n` exist without knowing which is its own.
Every phone waits for all `n` regardless of role. Withholding one stalls every phone
alike. The server cannot swap a parcel for one client, because the event is signed by
its author and `ready` hashes the full set. The only role-dependent reaction left is
`abort` for a bad slip, and that kills the attempt, so whatever it shows is about a
circle that no longer exists.

**F3. Long-term onion keys.** The draft sealed onion layers to long-term identity
keys. Anyone who later gets a player's personal link could peel that player's layer
from the stored log, recover their shuffle and weaken the mix after the fact. The same
key across attempts also lets an old onion be replayed through an honest mixer. *Fix:*
a fresh mix key per attempt, deleted after peeling, never in a backup. It costs one
extra automatic step. The layer purpose also binds round, attempt and position.

**F4. A mixer as a decryption oracle.** A forking server can hand an honest mixer two
different input lists: the real one, and one where everything but Alice's item is
fabricated. If the mixer peels both, the second output contains Alice's key among the
attacker's own, identifying it, while the first run continues and succeeds. *Fix:*
invariant I1. Output is stored before posting, the key is deleted, and reloads re-send
the stored output.

**F5. Check words can be ground.** Three words are 24 bits and the draft took them
straight from the roster hash. A server colluding with one player can vary a join
until two different rosters give the same words, in seconds on a laptop, and show each
half of the group a different world. *Fix:* commit-then-reveal per check version.
Nobody can predict the words before every roster entry is fixed. An attacker gets one
2⁻²⁴ guess per check version instead of an offline search. An earlier version of this
fix put the commitment in `join` and allowed removal afterwards. That was broken too:
choosing which of `k` Sybils to remove gives `2^k` free retries. Commits are now made
after lock, with fresh nonces per version.

**F6. Unauthenticated schedule.** The server's reveal time, zone and mail times were
trusted. It could move mail to match someone's habits or open the reveal early.
*Fix:* signed inside `create`, compared by every client.

**F7. Sizes give away group content.** Group entries were unpadded, so the server could
read nickname lengths from a join and tell event types apart. *Fix:* 512-byte blocks.
Mix events remain visibly large, which only shows that a draw is running.

**F8. Mail time leaked send time to friends.** A per-entry post time or a sequence
number taken at posting would let any player rebuild when each card was sent, which is
what mail time is meant to hide. *Fix:* held entries wait in a separate table with no
post time, and are released in random order with fresh sequence numbers.

### Integrity and fairness

**F9. Signatures that bound too little.** The draft did not say what each signature
covers. A confirmation of a circle hash alone says nothing about which roster or
attempt it belongs to, and a box signature on a card could be presented as one on a
reveal. *Fix:* section 2. Domain tag per role and type, with round and attempt inside
every signed object. Confirms cover the whole attempt transcript.

**F10. Replayed cards double a promise.** Re-posting a sealed card yields a second valid
card. *Fix:* each parcel has a random id, and the receiver deduplicates on it.

**F11. Late aborts.** With "any failure restarts", a player could abort a finished draw
days later and wipe the game. With a fold that depends on arrival order, a server could
split clients on whether a draw finished. *Fix:* for each player the first of `ready`,
`abort` or removal in log order decides, and a final attempt cannot change. A server
that forks here causes a stall, not a leak.

**F12. Re-rolling.** A player can read their slip and abort until they like it. A pair of
colluders can abort until they sit one apart around a victim, as in F1. This cannot be
removed, because any party able to refuse can refuse after seeing the result. *Fix:*
failures are capped at 4, then the round stops and the organiser starts a fresh one.
With 10 players a pair lands two apart by chance 2 times in 9, about 22%. Aborting
through all four attempts lifts that to about 63%, and every abort shows as a failed
draw. Recorded in the threat model.

**F13. Key confusion.** The draft named "identity keys" without separating them. *Fix:*
ECDSA and ECDH are separate keys, which WebCrypto enforces through key usages. HKDF
`info` labels separate every derived key, and seal purposes separate parcels from
layers.

**F14. Splitting a key pair.** A mixer could pair Alice's ECDH key with their own ECDSA
key. Alice would still "see her key", her giver's parcels would still reach her, and
cards from that slot would be forged. *Fix:* a player checks both keys, and the fold
rejects any repeated half.

**F16. Tagging through malformed onions.** A mixer can corrupt an item and watch who
aborts, which identifies that item's owner. *Accepted:* this works, and it only works on
an attempt that it kills. Fresh keys make what it learned useless.

**F17. Late-attempt replay.** Events from an old attempt reposted into a new one. *Fix:*
signatures and layer purposes bind the attempt, and every key is fresh. A replayed mix
list fails on signature, then on hash, then on opening.

**F19. Removal as a lever.** A forged or replayed removal could reshape the roster.
*Fix:* organiser-signed, with `index` and `a` bound, and subject to the 4-player floor.

**F23. A removal could reopen a finished check.** Found by a test while building. An
organiser could post a removal with `a` of 0 after the draw, which changed the roster,
invalidated the agreed words and wiped the game. *Fix:* each check version is evaluated
before the next removal is applied, so an agreed version ends the check for good.

**F24. A forked phone left the group stalled.** Found by a test while building. A phone
shown a different entry saw the attempt fail and moved on, while the others waited for
it forever. *Fix:* such a phone reports the failure, which ends the attempt for everyone.
This depends only on the log as shown to that phone, so it does not break I2.

**F25. Acting on part of the log.** Found by reading the code. The server pages the log.
A phone reloading a long round could fold the first page, take it for a draw in progress
and answer it, posting a stray `abort` for a key it no longer holds. *Fix:* the server
says when more remains, and a client reads to the end before folding or acting.

**F26. A restore during the check stalled everyone.** Found by reading the code. The check
nonce was not in the backup, so a restored phone could only reveal a nonce that matched
nothing. *Fix:* the nonce is backed up when it is made. It only needs hiding until every
commitment is in, and the backup is encrypted.

### Backups and metadata

**F15. A backup that reacts to arrivals is an oracle.** Refreshing the backup when a card
arrives would tell the server who just received one, and pair that person with whoever
posted it. *Fix:* backups refresh only when the player sends something and on public events.
Changing a guess does not count, since that often follows a card.

**F18. Non-extractable is weaker than it sounds.** The personal link has to stay
re-showable, so its secret sits in IndexedDB. Script in the page can read it. *Accepted
and stated:* non-extractability still stops a key being exported directly, and the real
defence is a strict content security policy with no third-party code. The draft's
statement that the server cannot tie a backup to a player is also too strong: it arrives
over the same connection as the player's other requests. It cannot be tied to a *name*
or read.

**F20. Payment details as a free-text channel.** An unchecked field would break the "no
free text" rule. *Fix:* sender and receiver both check the shape. An address can still
spell a short word in its name, which is noted in the threat model.

**F21. Signature malleability.** `(r, s)` and `(r, n-s)` both verify, so a server can
change a signature's bytes without a key. *Fix:* no hash, dedupe or identity is computed
over signature bytes.

**F22. Identity-signed slips can be shown around.** A giver holds a signed proof that a
name owns a box key. They could always have told people, but now they can prove it.
*Accepted:* this exposes only the target's own position, and the giver has to reveal
themselves as the holder. It is the cost of names that cannot be faked.

### Changes from the first draft

1. Onion layers use a per-attempt mix key, not a long-term identity key (F3).
2. Mix keys and seed commitments form a new first step (F1, F3).
3. Check words use commit-then-reveal, which needs every phone open after lock (F5).
4. Circle order comes from a jointly chosen seed, not the last mixer (F1).
5. Slips travel inside a signed group event instead of as a loose sealed entry, and a new
   `ready` step closes the attempt (F2). The parcel inside is the same sealed form.
6. Group entries are padded (F7). Held entries get fresh sequence numbers (F8).
7. Failed attempts are capped at 4 (F12).

## 10. What this cannot fix

- **The server ships the code.** An operator can serve altered JavaScript to one person
  and read everything. This is the main limit on "not even the server". Only an
  independently built client would close it.
- **Connection metadata.** The server sees when each connection posts. It cannot see who
  a parcel is for, but it can count how many parcels each connection sends.
- **Behaviour.** Friends can guess from who acts oddly, and a player can tell someone what
  they drew.
- **Circle structure.** Two colluders exactly two apart know the link of the player between
  them. If all but one player reveal, the last is known by elimination.
- **Dropped parcels.** A server can drop a card without anyone noticing. That costs a card,
  never privacy.
- **Stalling.** Any player can stop the draw by going quiet. The organiser can remove them,
  and the app does not assign blame.
- **The chat app.** The invite link and any personal link sent through a chat app are
  visible to whoever runs that chat service.

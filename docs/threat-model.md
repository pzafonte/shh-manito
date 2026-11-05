# Threat model

What 쉿! 마니또 protects, what it does not, and from whom. `docs/protocol.md` has the
mechanism and every attack tried against it. Nobody independent has reviewed either
document or the code. Treat every claim below as unreviewed.

## The claim

Before reveal day, nobody learns who drew whom, and that includes the person running the
server. This holds only if the code in the browser is the code in this repository. That
condition is the main limit, and it is covered first.

## What cannot be fixed here

**The server operator ships the code.** The same server that holds the log serves the
JavaScript. An operator can send altered code to one person and read their slip, their
keys and everything they do. No design served from a website closes this. An
independently built client would.

**Connection metadata.** The server sees when something is posted and from which
connection. It can count how many parcels each connection sends. It can tie a personal-link
backup to the connection that writes it. It cannot read the backup, and it cannot see a
nickname, so it can link a backup to a connection but not to a name. A server that also
knows who is behind a connection, such as an employer running it on its own network, knows
more than one that does not.

**Behaviour.** Friends can guess from who acts oddly. Anyone can tell someone what they drew.

**The chat app.** Invite links and personal links sent through a chat app are visible to
whoever runs that chat service. An invite link gives read access to nicknames, the round
name and reveals. A personal link gives access to that player's slip and everything else.
The app suggests sending the personal link to yourself, which is convenient and which trusts
the chat provider. It says plainly that anyone holding the link can see the slip.

## Who can learn what

| Who | Can learn | Cannot learn |
| --- | --- | --- |
| Someone with neither link | That a round id exists, if they guess one | Anything else |
| Server, passive | Timing, sizes, parcel counts per connection, roster size, how many draws failed | Names, cards, amounts, payment details, who drew whom, who a parcel is for |
| Server, active | The same, plus it can stall the game or silently drop a card | Who drew whom, by withholding, reordering or forging entries |
| Server with one colluding player | What that player knows, plus group traffic | Other players' links. Forking the roster is caught by the check words, up to a 1 in 16.7 million chance per attempt |
| Someone with the invite link | Nicknames, round name, reveals, draw traffic | Who drew whom, card contents |
| A player | Their own target, the cards they receive | Who is looking after them, until that person reveals |
| Their giver | That player's name, and that they sit one place along the circle | Who that player drew |
| Two colluding players | Their two targets | Others' links, unless they are exactly two apart (below) |
| Someone holding a personal link | Everything that player knows | Other players' links, or that player's shuffle in the draw |

## Known weaknesses

**Two colluders exactly two apart.** If A looks after X and X looks after B, then A and B
together know X's target. This comes with having a circle. With 10 players it happens to a
given pair 2 times in 9.

**Re-rolling.** A player who dislikes their slip can abort. A colluding pair can abort until
they sit two apart, which lifts that 22% to about 63% across the four allowed attempts. Every
abort shows up as a failed draw. This cannot be removed, because whoever can refuse can refuse
after seeing the result.

**Elimination.** If everyone but one person reveals, the last is known. A question mark is
only private while there are at least two.

**Small groups.** In a group of 4 your giver is one of 3 people. Mail times hide *when* a card
was sent, not that some card was sent. On reveal day the group knows who sent what.

**Provable slips.** A giver holds a signed proof that their target owns a box key. They could
always tell people. Now they can prove it. This exposes only the target's own position.

**Sybils.** One person can join several times with several browsers. Check words catch a forked
roster, not a padded one. The organiser locks the roster, and people can see who is on it.

**Stalling.** Any player can stop the draw by going quiet. The organiser can remove them, and the
app does not assign blame. A server can stall too. Stalling never reveals a link, because no phone
reacts differently depending on what it privately knows.

**Dropped cards.** A server can drop a card and nobody will notice. Giver and recipient may then
see different totals on reveal day. Promised, marked as paid and confirmed received are all
self-reports, and the app says so.

**Timing after reveal.** Settlement messages may hint at who is paying whom through their timing.
By then hiding the sender no longer matters.

**Script in the page.** Private keys are non-extractable, but the personal link secret stays
readable so the link can be shown again, and it can recover the keys. Any script running in the
page could read it. The defence is a strict content security policy, no third-party code and no
free text from other players.

**Payment details.** The field only accepts a Lightning address or invoice shape, on sending and on
receiving. An address can still spell a short word.

**Crypto.** Everything rests on WebCrypto, P-256, AES-GCM and the browser's random numbers. The
protocol is custom and has had no independent review. P-256 is not quantum-resistant, and a stored
log could be attacked later by a future quantum computer, though rounds are deleted 14 days after
reveal.

## What the server keeps

| Stored | Purpose | Deleted |
| --- | --- | --- |
| Round id, hash of the auth token | Finding a round, gating posts | 14 days after reveal |
| Reveal time, time zone, mail times | Scheduling mail and deletion | 14 days after reveal |
| Log entries, opaque | The game | 14 days after reveal |
| Mail waiting for the postman, opaque | Held cards | On delivery, or with the round |
| Personal-link backups, opaque, 16,412 bytes each | Restoring a player | 14 days after reveal |

It stores no time of posting, no IP addresses, no user agents, no cookies, no accounts, no email
addresses and no phone numbers. Addresses exist only in memory for rate limiting. Request logging is
off.

## Money

The app holds no sats, creates no invoices, talks to no Lightning node and takes no fee. A card
carries a promise, which is a number in a sealed parcel. Payment happens outside the app, directly
between players, after reveal day.

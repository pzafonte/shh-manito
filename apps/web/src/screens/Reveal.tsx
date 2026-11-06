import { CARD_IDS, DEFAULT_BUDGET_SATS, parseLink, PlayerClient, type CardId, type Player } from '@shh-manito/protocol';
import { useEffect, useState, type ReactNode } from 'react';
import { downloadCalendar, formatDayTime, formatSats, nextFridayEvening } from '../browser';
import { CopyButton, QrCode, Sticker, useReducedMotion } from '../components';
import { STICKER_EMOJI } from '../copy';
import { makeTransport, type GameHandle } from '../game';
import { useCopy, useLanguage } from '../i18n';
import { browserStore, saveSummary } from '../store';
import { useNow } from './Play';

const HOUR_MS = 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;
const FILL_STEP_MS = 650;

const RING = { centre: 160, radius: 118, viewBox: 320 };

function nodeRadius(count: number): number {
  return Math.max(10, Math.min(30, (Math.PI * RING.radius) / count - 3));
}

// The circle fills in one person at a time, which is the moment everyone waits for.
function useFill(total: number): number {
  const instant = useReducedMotion();
  const [shown, setShown] = useState(instant ? total : 0);
  useEffect(() => {
    if (instant) {
      setShown(total);
      return;
    }
    if (shown >= total) return;
    const timer = setTimeout(() => setShown(shown + 1), FILL_STEP_MS);
    return () => clearTimeout(timer);
  }, [instant, shown, total]);
  return Math.min(shown, total);
}

function Circle({ game }: { game: GameHandle }): ReactNode {
  const { reveal } = useCopy();
  const { client } = game;
  const circle = client.state.final!.circle!;
  const count = circle.length;
  const reveals = client.state.reveals;
  const shownCount = useFill(reveals.length);
  const shown = reveals.slice(0, shownCount);
  const atPosition = new Map<number, Player | undefined>(
    shown.map((entry) => [entry.position, client.state.roster.find((player) => player.fp === entry.fp)]),
  );
  const radius = nodeRadius(count);

  const points = circle.map((_, index) => {
    const angle = -Math.PI / 2 + (index / count) * Math.PI * 2;
    return {
      x: RING.centre + RING.radius * Math.cos(angle),
      y: RING.centre + RING.radius * Math.sin(angle),
    };
  });

  const pairs = [...atPosition.entries()]
    .sort(([left], [right]) => left - right)
    .map(([position, player]) => {
      const next = atPosition.get((position + 1) % count);
      return reveal.arrow(player?.nickname ?? '?', next?.nickname ?? '?');
    });

  return (
    <>
      <svg
        className="ring"
        viewBox={`0 0 ${RING.viewBox} ${RING.viewBox}`}
        role="img"
        aria-label={pairs.length > 0 ? pairs.join(', ') : reveal.circleNobody}
      >
        {points.map((from, index) => {
          const to = points[(index + 1) % count]!;
          return <line key={index} className="ring-line" x1={from.x} y1={from.y} x2={to.x} y2={to.y} />;
        })}
        {points.map((point, index) => {
          const player = atPosition.get(index);
          const mine = index === client.position && player !== undefined;
          return (
            <g key={index}>
              <circle className={mine ? 'ring-node ring-me' : 'ring-node'} cx={point.x} cy={point.y} r={radius} />
              <text className="ring-text" x={point.x} y={point.y} fontSize={radius * 1.1}>
                {player ? STICKER_EMOJI[player.sticker] : '?'}
              </text>
            </g>
          );
        })}
      </svg>
      {pairs.length > 0 && (
        <ul className="pairs" aria-live="polite">
          {pairs.map((pair) => (
            <li key={pair}>{pair}</li>
          ))}
        </ul>
      )}
    </>
  );
}

function Countdown({ game }: { game: GameHandle }): ReactNode {
  const { reveal } = useCopy();
  const { language } = useLanguage();
  const meta = game.client.state.meta!;
  const now = useNow();
  const left = Math.max(0, meta.revealAt - now);
  const days = Math.floor(left / (24 * HOUR_MS));
  const hours = Math.floor((left % (24 * HOUR_MS)) / HOUR_MS);
  const minutes = Math.floor((left % HOUR_MS) / MINUTE_MS);
  return (
    <>
      <p className="countdown" role="timer">
        {reveal.countdown(days, hours, minutes)}
      </p>
      <p>{reveal.when(formatDayTime(meta.revealAt, language))}</p>
      <button
        type="button"
        className="btn btn-quiet"
        onClick={() => downloadCalendar(reveal.calendarTitle(meta.name), meta.revealAt)}
      >
        {reveal.calendar}
      </button>
    </>
  );
}

function GiverLine({ game }: { game: GameHandle }): ReactNode {
  const { reveal } = useCopy();
  const { client } = game;
  const giver = client.giver;
  if (!giver) return <p>{reveal.giverHidden}</p>;
  const guessed = client.state.roster.find((player) => player.fp === client.local.guess);
  let verdict = reveal.noGuess;
  if (guessed) verdict = guessed.fp === giver.fp ? reveal.guessRight : reveal.guessWrong(guessed.nickname);
  return (
    <>
      <p className="giver">
        <Sticker id={giver.sticker} /> {reveal.giver(giver.nickname)}
      </p>
      <p>{verdict}</p>
    </>
  );
}

function Facts({ promised, paid, got }: { promised: string; paid: boolean; got: boolean }): ReactNode {
  const { settle } = useCopy();
  return (
    <dl className="facts">
      <dt>{settle.factsPromised}</dt>
      <dd>{promised}</dd>
      <dt>{settle.factsPaid}</dt>
      <dd>{paid ? `✓ ${settle.yes}` : settle.no}</dd>
      <dt>{settle.factsGot}</dt>
      <dd>{got ? `✓ ${settle.yes}` : settle.no}</dd>
    </dl>
  );
}

function Getting({ game }: { game: GameHandle }): ReactNode {
  const { settle } = useCopy();
  const { language } = useLanguage();
  const { client } = game;
  const [detail, setDetail] = useState('');
  const [bad, setBad] = useState(false);
  const total = client.inbox.cards.reduce((sum, card) => sum + BigInt(card.amount), 0n);
  const mine = client.local.settlement;
  if (total === 0n) return null;
  const sats = formatSats(total, language);

  return (
    <section className="panel stack">
      <h2>{settle.gettingTitle}</h2>
      <p>{settle.promisedToYou(sats)}</p>
      <Facts promised={sats} paid={client.inbox.paid} got={mine.got} />
      {mine.waived ? (
        <p>{settle.keptIt}</p>
      ) : (
        <>
          {mine.detail ? (
            <p>{settle.detailSent}</p>
          ) : (
            <form
              className="stack"
              onSubmit={(event) => {
                event.preventDefault();
                void game.act(() => client.sharePaymentDetail(detail)).then((ok) => setBad(!ok));
              }}
            >
              <label className="field">
                <span>{settle.detailLabel}</span>
                <input
                  value={detail}
                  autoCapitalize="none"
                  autoCorrect="off"
                  autoComplete="off"
                  spellCheck={false}
                  onChange={(event) => {
                    setDetail(event.target.value);
                    setBad(false);
                  }}
                />
                <small className="note">{settle.detailHint}</small>
              </label>
              {bad && <p role="alert">{settle.detailBad}</p>}
              <button type="submit" className="btn" disabled={detail.trim().length === 0}>
                {settle.detailSend}
              </button>
            </form>
          )}
          <p>{client.inbox.paid ? settle.markedPaid : settle.notPaid}</p>
          {mine.got ? (
            <p>{settle.gotDone}</p>
          ) : (
            <>
              {client.inbox.paid && (
                <button type="button" className="btn" onClick={() => void game.act(() => client.confirmReceived())}>
                  {settle.gotIt}
                </button>
              )}
              <button type="button" className="btn btn-quiet" onClick={() => void game.act(() => client.waivePromise())}>
                {settle.keepIt}
              </button>
            </>
          )}
        </>
      )}
    </section>
  );
}

function Giving({ game }: { game: GameHandle }): ReactNode {
  const { settle } = useCopy();
  const { language } = useLanguage();
  const { client } = game;
  const total = client.promisedTotal;
  if (total === 0n) return null;
  const sats = formatSats(total, language);
  const { payDetail, waived, got } = client.inbox;
  const paid = client.local.settlement.paid;

  return (
    <section className="panel stack">
      <h2>{settle.givingTitle}</h2>
      <p>{settle.youPromised(sats)}</p>
      <Facts promised={sats} paid={paid} got={got} />
      {waived ? (
        <p>{settle.theyWaived}</p>
      ) : payDetail ? (
        <>
          <a className="btn" href={`lightning:${payDetail}`}>
            {settle.payOpen}
          </a>
          <CopyButton text={payDetail} label={settle.payCopy} done={settle.payCopied} />
          <QrCode text={`lightning:${payDetail}`} alt={settle.payQr} />
          <p className="note">{settle.payCheck(sats)}</p>
          {paid ? (
            <p>{settle.paidDone}</p>
          ) : (
            <button type="button" className="btn" onClick={() => void game.act(() => client.markPaid())}>
              {settle.paid}
            </button>
          )}
        </>
      ) : (
        <p>{settle.waitDetail}</p>
      )}
      {got && <p>{settle.theyGot}</p>}
    </section>
  );
}

function Settle({ game }: { game: GameHandle }): ReactNode {
  const { settle } = useCopy();
  const { client } = game;
  const nothing = client.promisedTotal === 0n && client.inbox.cards.every((card) => card.amount === '0');
  return (
    <section className="stack">
      <h2>{settle.title}</h2>
      <p>{settle.explain}</p>
      {nothing ? <p>{settle.nothing}</p> : <p className="note">{settle.selfReport}</p>}
      <Giving game={game} />
      <Getting game={game} />
    </section>
  );
}

function Thanks({ game }: { game: GameHandle }): ReactNode {
  const copy = useCopy();
  const { after } = copy;
  const { client } = game;
  const [card, setCard] = useState<CardId | null>(null);
  const sent = client.local.settlement.thanks;
  return (
    <section className="panel stack">
      <h2>{after.thanksTitle}</h2>
      {client.inbox.thanks && (
        <p>
          {after.thanksGot} “{copy.cards[client.inbox.thanks]}”
        </p>
      )}
      {sent ? (
        <p>{after.thanksSent}</p>
      ) : (
        <form
          className="stack"
          onSubmit={(event) => {
            event.preventDefault();
            if (card) void game.act(() => client.sendThanks(card));
          }}
        >
          <p>{after.thanksBody}</p>
          <div className="cards">
            {CARD_IDS.map((id) => (
              <label key={id} className="note-card">
                <input type="radio" name="thanks" checked={card === id} onChange={() => setCard(id)} />
                <span>{copy.cards[id]}</span>
              </label>
            ))}
          </div>
          <button type="submit" className="btn" disabled={!card}>
            {after.thanksSend}
          </button>
        </form>
      )}
    </section>
  );
}

function Keepsake({ game }: { game: GameHandle }): ReactNode {
  const { after } = useCopy();
  const { client } = game;
  const meta = client.state.meta!;
  const giver = client.giver;
  return (
    <section className="keepsake" aria-label={after.keepsakeTitle}>
      <h2 className="plain-heading">{meta.name}</h2>
      <p className="note">{after.keepsakeTitle}</p>
      {client.target && <p className="keepsake-line">{after.keepsakeLookedAfter(client.target.nickname)}</p>}
      <p className="keepsake-line">{giver ? after.keepsakeGiver(giver.nickname) : after.keepsakeGiverUnknown}</p>
      <p>
        {after.keepsakeSent(client.local.sent.length)} · {after.keepsakeReceived(client.inbox.cards.length)}
      </p>
      <p>{after.keepsakePlayers(client.state.roster.length)}</p>
      <p className="note">{after.keepsakeAlt}</p>
    </section>
  );
}

async function startRematch(game: GameHandle, onOpen: (client: PlayerClient) => void): Promise<void> {
  const { client } = game;
  const me = client.state.roster.find((player) => player.fp === client.local.fp)!;
  const meta = client.state.meta!;
  const existing = client.state.rematchLink && parseLink(client.state.rematchLink);
  const summaryOf = (next: PlayerClient) =>
    saveSummary({
      roundId: next.local.roundId,
      name: meta.name,
      nickname: me.nickname,
      revealAt: next.state.meta?.revealAt ?? 0,
      linkSaved: false,
      slipPulled: false,
      cardsSeen: 0,
    });

  if (existing) {
    const next = await PlayerClient.join(existing.roundId, existing.secret, me.nickname, me.sticker, makeTransport, browserStore);
    await summaryOf(next);
    onOpen(next);
    return;
  }
  const next = await PlayerClient.create(
    {
      name: meta.name,
      revealAt: nextFridayEvening(new Date()).getTime(),
      timeZone: meta.timeZone,
      mailTimes: meta.mailTimes,
      // Rounds from before sats became standard can have a budget of zero.
      budget: client.satsOn ? meta.budget : DEFAULT_BUDGET_SATS,
      nickname: me.nickname,
      sticker: me.sticker,
    },
    makeTransport,
    browserStore,
  );
  await summaryOf(next);
  await client.proposeRematch(next.inviteLink);
  onOpen(next);
}

function PlayAgain({ game, onOpen }: { game: GameHandle; onOpen(client: PlayerClient): void }): ReactNode {
  const { after } = useCopy();
  const [busy, setBusy] = useState(false);
  const exists = game.client.state.rematchLink !== null;
  return (
    <section className="stack">
      <button
        type="button"
        className="btn"
        disabled={busy}
        onClick={() => {
          setBusy(true);
          void startRematch(game, onOpen).finally(() => setBusy(false));
        }}
      >
        {exists ? after.againJoin : after.again}
      </button>
      <p className="note">{after.againNote}</p>
    </section>
  );
}

export function RevealTab({ game, onOpen }: { game: GameHandle; onOpen(client: PlayerClient): void }): ReactNode {
  const { reveal } = useCopy();
  const { client } = game;
  const now = useNow();
  const meta = client.state.meta!;
  const open = now >= meta.revealAt;
  const final = client.state.final!;
  const total = final.circle!.length;

  return (
    <>
      <h1>{reveal.title}</h1>
      {!open && <Countdown game={game} />}
      {open && (
        <>
          <Circle game={game} />
          <p role="status">{reveal.revealedCount(client.state.reveals.length, total)}</p>
          {client.hasRevealed ? (
            <GiverLine game={game} />
          ) : (
            <>
              <p>{reveal.noForce}</p>
              <button type="button" className="btn" onClick={() => void game.act(() => client.reveal())}>
                {reveal.press}
              </button>
              <p className="note">{reveal.pressNote}</p>
            </>
          )}
          {client.state.reveals.length < total && <p className="note">{reveal.lostNote}</p>}
          {client.satsOn && <Settle game={game} />}
          {(client.hasRevealed || client.giver) && (
            <>
              <Thanks game={game} />
              <Keepsake game={game} />
            </>
          )}
          <PlayAgain game={game} onOpen={onOpen} />
        </>
      )}
    </>
  );
}

export function Stuck({ game, onOpen }: { game: GameHandle; onOpen(client: PlayerClient): void }): ReactNode {
  const { stuck } = useCopy();
  const { client } = game;
  const [busy, setBusy] = useState(false);
  const organiser = client.state.roster.find((player) => player.fp === client.state.meta?.organiser);
  const exists = client.state.rematchLink !== null;
  const canAct = client.isOrganiser || exists;
  return (
    <section className="panel stack" role="alert">
      <h1>{stuck.title}</h1>
      <p>{stuck.body}</p>
      {canAct ? (
        <button
          type="button"
          className="btn"
          disabled={busy}
          onClick={() => {
            setBusy(true);
            void startRematch(game, onOpen).finally(() => setBusy(false));
          }}
        >
          {exists ? stuck.joinNew : stuck.restart}
        </button>
      ) : (
        <p className="note">{stuck.waitNew(organiser?.nickname ?? '')}</p>
      )}
    </section>
  );
}

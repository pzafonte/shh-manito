import { CARD_IDS, mailTimesOnDay, nextMailTime, type CardId, type SendRefusal } from '@shh-manito/protocol';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { formatSats, formatTime } from '../browser';
import { Bag, Slip } from '../components';
import type { GameHandle } from '../game';
import { useCopy, useLanguage } from '../i18n';

export type Tab = 'home' | 'draw' | 'send' | 'inbox' | 'reveal';

const DAY_MS = 24 * 60 * 60 * 1000;
const CLOCK_TICK_MS = 30_000;
const PROMISE_STEPS = [100n, 500n, 1000n, 5000n];

export function useNow(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), CLOCK_TICK_MS);
    return () => clearInterval(timer);
  }, []);
  return now;
}

export function Home({
  game,
  unread,
  onTab,
  onPersonal,
}: {
  game: GameHandle;
  unread: number;
  onTab(tab: Tab): void;
  onPersonal(): void;
}): ReactNode {
  const copy = useCopy();
  const { home } = copy;
  const { language } = useLanguage();
  const { client, summary } = game;
  const now = useNow();
  const meta = client.state.meta!;
  const revealOpen = now >= meta.revealAt;
  const nextPost = formatTime(nextMailTime(now, meta.mailTimes, meta.timeZone), language);
  const daysLeft = Math.ceil((meta.revealAt - now) / DAY_MS);

  const action: { label: string; tab: Tab } = !summary.slipPulled
    ? { label: home.actionSlip, tab: 'draw' }
    : revealOpen
      ? { label: home.actionReveal, tab: 'reveal' }
      : unread > 0
        ? { label: home.actionRead, tab: 'inbox' }
        : { label: home.actionSend, tab: 'send' };

  return (
    <>
      <h1 className="plain-heading">{home.hello(summary.nickname)}</h1>
      <section className="panel home-facts">
        <p className={unread > 0 ? 'fact fact-hot' : 'fact'}>
          <span aria-hidden="true">💌</span> {unread > 0 ? home.unread(unread) : home.noUnread}
        </p>
        <p className="fact">
          <span aria-hidden="true">📮</span> {home.nextPost(nextPost)}
        </p>
        <p className="fact">
          <span aria-hidden="true">⭕</span> {revealOpen ? home.revealOpen : home.untilReveal(daysLeft)}
        </p>
        {client.local.sent.length > 0 && (
          <p className="fact">
            <span aria-hidden="true">✍️</span> {home.sentCount(client.local.sent.length)}
          </p>
        )}
      </section>
      <button type="button" className="btn" onClick={() => onTab(action.tab)}>
        {action.label}
      </button>
      {!summary.linkSaved && (
        <section className="panel panel-warm">
          <p>{copy.personal.remind}</p>
          <button type="button" className="btn btn-quiet" onClick={onPersonal}>
            {copy.personal.remindOpen}
          </button>
        </section>
      )}
    </>
  );
}

export function DrawTab({ game }: { game: GameHandle }): ReactNode {
  const { draw } = useCopy();
  const { client, summary } = game;
  const [justPulled, setJustPulled] = useState(false);

  if (!summary.slipPulled) {
    return (
      <>
        <Bag busy={false} />
        <h1>{draw.ready}</h1>
        <p>{draw.readyBody}</p>
        <button
          type="button"
          className="btn"
          onClick={() => {
            setJustPulled(true);
            game.updateSummary({ slipPulled: true });
          }}
        >
          {draw.pull}
        </button>
      </>
    );
  }
  return <Slip target={client.target} unfold={justPulled} />;
}

function promiseChoices(left: bigint): bigint[] {
  const steps = PROMISE_STEPS.filter((step) => step <= left);
  return [...steps, 0n];
}

function refusalText(copy: ReturnType<typeof useCopy>, refusal: SendRefusal | undefined): string {
  switch (refusal) {
    case 'too-many':
      return copy.send.tooMany;
    case 'over-budget':
    case 'bad-amount':
      return copy.send.over;
    case 'past-reveal':
      return copy.send.pastReveal;
    default:
      return copy.send.notReady;
  }
}

function SendHistory({ game }: { game: GameHandle }): ReactNode {
  const copy = useCopy();
  const { send } = copy;
  const { language } = useLanguage();
  const { client } = game;
  const now = useNow();
  const sent = client.local.sent;
  if (sent.length === 0) return <p className="note">{send.empty}</p>;
  return (
    <section className="stack">
      <h2>{send.history}</h2>
      <ul className="cards-list">
        {[...sent].reverse().map((item) => {
          const status =
            item.arrives === null
              ? send.waiting
              : item.arrives <= now
                ? send.arrived
                : send.arrives(formatTime(item.arrives, language));
          return (
            <li key={item.id} className="mail">
              <span className="mail-line">{copy.cards[item.card]}</span>
              <span className="note">
                {client.satsOn && item.amount !== '0' ? `${send.amount(formatSats(item.amount, language))} · ` : ''}
                {status}
              </span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function Ideas(): ReactNode {
  const { send } = useCopy();
  const [index, setIndex] = useState<number | null>(null);
  return (
    <section className="stack">
      {index === null ? (
        <button type="button" className="btn btn-quiet" onClick={() => setIndex(0)}>
          {send.ideaToggle}
        </button>
      ) : (
        <div className="panel stack">
          <p className="note">{send.ideaIntro}</p>
          <p className="idea">{send.ideas[index % send.ideas.length]}</p>
          <button type="button" className="btn btn-quiet" onClick={() => setIndex(index + 1)}>
            {send.moreIdeas}
          </button>
        </div>
      )}
    </section>
  );
}

export function SendTab({ game }: { game: GameHandle }): ReactNode {
  const copy = useCopy();
  const { send } = copy;
  const { language } = useLanguage();
  const { client } = game;
  const now = useNow();
  const left = client.budgetLeft;
  const choices = useMemo(() => promiseChoices(left), [left]);
  const [card, setCard] = useState<CardId | null>(null);
  const [amount, setAmount] = useState<bigint>(choices[0] ?? 0n);
  const [result, setResult] = useState<{ text: string; good: boolean } | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!choices.includes(amount)) setAmount(choices[0] ?? 0n);
  }, [choices, amount]);

  if (now >= client.state.meta!.revealAt) {
    return (
      <>
        <h1>{send.title}</h1>
        <p>{send.pastReveal}</p>
        <SendHistory game={game} />
      </>
    );
  }

  const submit = async (): Promise<void> => {
    if (!card) return;
    setBusy(true);
    const sent = await game.act(() => client.sendCard(card, client.satsOn ? amount.toString() : '0'));
    setBusy(false);
    if (!sent.ok) {
      setResult({ text: refusalText(copy, sent.refusal), good: false });
      return;
    }
    setCard(null);
    setResult({
      text: sent.arrives ? send.sent(formatTime(sent.arrives, language)) : send.queued,
      good: true,
    });
  };

  return (
    <>
      <h1>{send.title}</h1>
      <form
        className="stack"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <fieldset>
          <legend>{send.pickCard}</legend>
          <div className="cards">
            {CARD_IDS.map((id) => (
              <label key={id} className="note-card">
                <input
                  type="radio"
                  name="card"
                  checked={card === id}
                  onChange={() => {
                    setCard(id);
                    setResult(null);
                  }}
                />
                <span>{copy.cards[id]}</span>
              </label>
            ))}
          </div>
        </fieldset>
        {client.satsOn && (
          <fieldset>
            <legend>{send.pickAmount}</legend>
            <div className="pills">
              {choices.map((choice) => (
                <label key={choice.toString()} className="pill">
                  <input type="radio" name="amount" checked={amount === choice} onChange={() => setAmount(choice)} />
                  <span>{choice === 0n ? send.noPromise : send.amount(formatSats(choice, language))}</span>
                </label>
              ))}
            </div>
            <p className="note">{send.left(formatSats(left, language))}</p>
          </fieldset>
        )}
        <p className="note">{send.why}</p>
        <div className="send-bar">
          <button type="submit" className="btn" disabled={!card || busy}>
            {send.submit}
          </button>
        </div>
        {!card && !result && <p className="note">{send.pickFirst}</p>}
        <div aria-live="polite">{result && <p className={result.good ? 'sent' : 'banner'}>{result.text}</p>}</div>
      </form>
      <Ideas />
      <SendHistory game={game} />
    </>
  );
}

export function InboxTab({ game }: { game: GameHandle }): ReactNode {
  const copy = useCopy();
  const { inbox } = copy;
  const { language } = useLanguage();
  const { client, summary } = game;
  const now = useNow();
  const meta = client.state.meta!;
  const cards = client.inbox.cards;
  const nextPost = formatTime(nextMailTime(now, meta.mailTimes, meta.timeZone), language);
  const others = client.state.roster.filter((player) => player.fp !== client.local.fp);

  useEffect(() => {
    if (cards.length !== summary.cardsSeen) game.updateSummary({ cardsSeen: cards.length });
  }, [cards.length, summary.cardsSeen, game]);

  const times = mailTimesOnDay(now, meta.mailTimes, meta.timeZone)
    .map((instant) => formatTime(instant, language))
    .join(', ');

  return (
    <>
      <h1>{inbox.title}</h1>
      <p className="note">{inbox.postman(times)}</p>
      {cards.length === 0 ? (
        <p className="panel">{inbox.empty(nextPost)}</p>
      ) : (
        <ul className="cards-list">
          {[...cards].reverse().map((card) => (
            <li key={card.id} className="mail">
              <span className="note">{inbox.from}</span>
              <span className="mail-line">{copy.cards[card.card]}</span>
              {client.satsOn && card.amount !== '0' && (
                <span className="mail-promise">{inbox.promise(formatSats(card.amount, language))}</span>
              )}
              {card.visibleAt && <span className="note">{inbox.postedAt(formatTime(card.visibleAt, language))}</span>}
            </li>
          ))}
        </ul>
      )}
      <section className="panel stack">
        <label className="field">
          <span>{inbox.guess}</span>
          <select
            value={client.local.guess ?? ''}
            onChange={(event) => void game.act(() => client.setGuess(event.target.value || null))}
          >
            <option value="">{inbox.guessNone}</option>
            {others.map((player) => (
              <option key={player.fp} value={player.fp}>
                {player.nickname}
              </option>
            ))}
          </select>
        </label>
        <p className="note">{inbox.guessNote}</p>
      </section>
    </>
  );
}

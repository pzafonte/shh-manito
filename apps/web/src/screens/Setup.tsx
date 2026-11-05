import { MIN_PLAYERS, type Player } from '@shh-manito/protocol';
import { useState, type ReactNode } from 'react';
import { absoluteLink, copyText, shareText } from '../browser';
import { Bag, CopyButton, InAppNotice, QrCode, Sticker } from '../components';
import { CHECK_WORDS } from '../copy';
import type { GameHandle } from '../game';
import { useCopy, useLanguage } from '../i18n';
import { PersonalLinkPanel } from './Overlays';

function namesOf(players: readonly Player[], fps: readonly string[]): string {
  return fps
    .map((fp) => players.find((player) => player.fp === fp)?.nickname)
    .filter(Boolean)
    .join(', ');
}

function NudgeButton({ game, waitingOn }: { game: GameHandle; waitingOn: readonly string[] }): ReactNode {
  const { draw } = useCopy();
  const [copied, setCopied] = useState(false);
  const { client } = game;
  const names = namesOf(client.state.roster, waitingOn);
  return (
    <>
      <button
        type="button"
        className="btn btn-quiet"
        onClick={() => {
          void copyText(draw.nudgeText(names, absoluteLink(client.inviteLink))).then(setCopied);
        }}
      >
        {draw.nudge}
      </button>
      {copied && <p role="status">{draw.nudged}</p>}
    </>
  );
}

function RemoveControls({ game, waitingOn }: { game: GameHandle; waitingOn: readonly string[] }): ReactNode {
  const { draw } = useCopy();
  const [asking, setAsking] = useState<Player | null>(null);
  const { client } = game;
  const canRemove = client.state.roster.length > MIN_PLAYERS;
  const stalled = client.state.roster.filter((player) => waitingOn.includes(player.fp) && player.fp !== client.local.fp);

  if (stalled.length === 0) return null;
  if (!canRemove) return <p className="note">{draw.tooFew}</p>;

  return (
    <section className="panel stack">
      <h2>{draw.removeTitle}</h2>
      <p className="note">{draw.removeHint}</p>
      {asking ? (
        <div className="stack" role="group" aria-label={draw.removeConfirm(asking.nickname)}>
          <p>{draw.removeConfirm(asking.nickname)}</p>
          <button
            type="button"
            className="btn"
            onClick={() => {
              void game.act(() => client.remove(asking.fp));
              setAsking(null);
            }}
          >
            {draw.removeYes}
          </button>
          <button type="button" className="btn btn-quiet" onClick={() => setAsking(null)}>
            {draw.removeNo}
          </button>
        </div>
      ) : (
        stalled.map((player) => (
          <button key={player.fp} type="button" className="btn btn-quiet" onClick={() => setAsking(player)}>
            {draw.remove(player.nickname)}
          </button>
        ))
      )}
    </section>
  );
}

export function Waiting({ game }: { game: GameHandle }): ReactNode {
  const copy = useCopy();
  const { waiting } = copy;
  const { client, summary } = game;
  const [showQr, setShowQr] = useState(false);
  const inviteUrl = absoluteLink(client.inviteLink);
  const players = client.state.joined;
  const needed = Math.max(0, MIN_PLAYERS - players.length);
  const meta = client.state.meta;
  const organiser = players.find((player) => player.fp === meta?.organiser);

  return (
    <>
      <Bag busy={false} />
      <h1>{waiting.title}</h1>
      <InAppNotice url={inviteUrl} />
      <section className="panel stack">
        <h2>{waiting.shareTitle}</h2>
        <p>{waiting.shareHint}</p>
        <button
          type="button"
          className="btn"
          onClick={() => void shareText(waiting.shareText(meta?.name ?? copy.brand), inviteUrl)}
        >
          {waiting.share}
        </button>
        <CopyButton text={inviteUrl} label={waiting.copy} done={waiting.copied} />
        <button type="button" className="btn btn-quiet" aria-expanded={showQr} onClick={() => setShowQr(!showQr)}>
          {showQr ? waiting.qrHide : waiting.qrShow}
        </button>
        {showQr && <QrCode text={inviteUrl} alt={waiting.qrAlt} size={640} />}
      </section>
      <section className="panel stack" aria-live="polite">
        <h2>{waiting.here(players.length)}</h2>
        <ul className="people">
          {players.map((player) => (
            <li key={player.fp}>
              <Sticker id={player.sticker} />
              <span>{player.nickname}</span>
              {player.fp === client.local.fp && <small className="tag">{waiting.you}</small>}
              {player.fp === meta?.organiser && <small className="tag">{waiting.organiser}</small>}
            </li>
          ))}
        </ul>
        <p>{needed > 0 ? waiting.needMore(needed) : waiting.canStart}</p>
      </section>
      {client.isOrganiser ? (
        <section className="stack">
          <button type="button" className="btn" disabled={needed > 0} onClick={() => void game.act(() => client.lock())}>
            {waiting.lock}
          </button>
          <p className="note">{waiting.lockHint}</p>
        </section>
      ) : (
        <p className="note">{waiting.waitOrganiser(organiser?.nickname ?? '')}</p>
      )}
      {!summary.linkSaved && <PersonalLinkPanel game={game} />}
    </>
  );
}

export function Check({ game }: { game: GameHandle }): ReactNode {
  const { check } = useCopy();
  const { language } = useLanguage();
  const { client } = game;
  const view = client.state.check;
  const [asking, setAsking] = useState(false);
  const organiser = client.state.roster.find((player) => player.fp === client.state.meta?.organiser);

  if (!view?.words) {
    const waitingOn = view?.waitingOn ?? [];
    return (
      <>
        <Bag busy />
        <h1>{check.preparing}</h1>
        {waitingOn.length > 0 && <p role="status">{check.waitingFor(namesOf(client.state.roster, waitingOn))}</p>}
        {client.isOrganiser && waitingOn.length > 0 && (
          <>
            <NudgeButton game={game} waitingOn={waitingOn} />
            <RemoveControls game={game} waitingOn={waitingOn} />
          </>
        )}
      </>
    );
  }

  const primary = language === 'ko' ? 0 : 1;
  return (
    <>
      <h1>{check.title}</h1>
      <p>{check.body}</p>
      <ol className="check-words">
        {view.words.map((index, position) => {
          const word = CHECK_WORDS[index]!;
          return (
            <li key={position}>
              <b>{word[primary]}</b>
              <small lang={primary === 0 ? 'en' : 'ko'}>{word[1 - primary]}</small>
            </li>
          );
        })}
      </ol>
      {client.isOrganiser ? (
        <button type="button" className="btn" onClick={() => void game.act(() => client.confirmMatch())}>
          {check.match}
        </button>
      ) : (
        <p className="note">{check.waitOrganiser(organiser?.nickname ?? '')}</p>
      )}
      {asking ? (
        <div className="panel stack" role="group" aria-label={check.different}>
          <p>{check.differentConfirm}</p>
          <button type="button" className="btn" onClick={() => void game.act(() => client.stopTakingPart())}>
            {check.differentYes}
          </button>
          <button type="button" className="btn btn-quiet" onClick={() => setAsking(false)}>
            {check.differentNo}
          </button>
        </div>
      ) : (
        <button type="button" className="btn btn-quiet" onClick={() => setAsking(true)}>
          {check.different}
        </button>
      )}
    </>
  );
}

function drawLine(game: GameHandle, copy: ReturnType<typeof useCopy>): string {
  const { client } = game;
  const view = client.state.current;
  if (!view) return copy.draw.getting;
  const names = namesOf(client.state.roster, view.waitingOn);
  switch (view.stage) {
    case 'mixing':
      return view.waitingOn.includes(client.local.fp) ? copy.draw.myTurn : copy.draw.turn(names);
    case 'slips':
    case 'ready':
      return copy.draw.wrapping;
    default:
      return view.waitingOn.length > 0 ? copy.draw.waitingFor(names) : copy.draw.getting;
  }
}

export function Draw({ game }: { game: GameHandle }): ReactNode {
  const copy = useCopy();
  const { draw } = copy;
  const { client } = game;
  const view = client.state.current;
  const roster = client.state.roster;
  const mixed = view?.stage === 'mixing' ? view.mixStep : view && view.mixStep > 0 ? roster.length : 0;
  const failed = client.state.failures > 0;
  const waitingOn = view?.waitingOn ?? [];

  return (
    <>
      <Bag busy />
      <h1>{draw.title}</h1>
      <p role="status" className="draw-line">
        {drawLine(game, copy)}
      </p>
      {failed && <p className="note">{draw.tangled}</p>}
      <ol className="shuffle" aria-label={draw.chipsLabel}>
        {roster.map((player, index) => {
          const done = index < mixed;
          return (
            <li key={player.fp} className={done ? 'done' : undefined} aria-label={done ? draw.done(player.nickname) : draw.pending(player.nickname)}>
              {done ? '✓ ' : ''}
              {player.nickname}
            </li>
          );
        })}
      </ol>
      <p className="note">{draw.keepOpen}</p>
      {client.isOrganiser && waitingOn.length > 0 && (
        <>
          <NudgeButton game={game} waitingOn={waitingOn} />
          <RemoveControls game={game} waitingOn={waitingOn} />
        </>
      )}
    </>
  );
}

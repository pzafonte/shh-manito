import {
  MAX_PLAYERS,
  normaliseNickname,
  OfflineError,
  PlayerClient,
  type RoundLink,
  type RoundState,
  type StickerId,
} from '@shh-manito/protocol';
import { useState, type ReactNode } from 'react';
import { absoluteLink } from '../browser';
import { Bag, Header, InAppNotice, StickerPicker } from '../components';
import { makeTransport } from '../game';
import { useCopy } from '../i18n';
import { browserStore, saveSummary } from '../store';
import { HowTo } from './Overlays';

export function Join({
  link,
  state,
  onJoined,
}: {
  link: RoundLink;
  state: RoundState;
  onJoined(client: PlayerClient): void;
}): ReactNode {
  const copy = useCopy();
  const [nickname, setNickname] = useState('');
  const [sticker, setSticker] = useState<StickerId | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [taken, setTaken] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [showHowTo, setShowHowTo] = useState(false);

  if (showHowTo) return <HowTo satsOn={false} onClose={() => setShowHowTo(false)} />;

  const full = state.joined.length >= MAX_PLAYERS;

  const submit = async (): Promise<void> => {
    const trimmed = nickname.trim();
    if (!trimmed || !sticker) return setProblem(copy.join.missing);

    setBusy(true);
    setProblem(null);
    setTaken(null);
    try {
      const latest = await PlayerClient.peek(link.roundId, link.secret, makeTransport);
      const wanted = normaliseNickname(trimmed);
      if (latest.joined.some((player) => normaliseNickname(player.nickname) === wanted)) {
        setTaken(trimmed);
        setBusy(false);
        return;
      }
      const client = await PlayerClient.join(link.roundId, link.secret, trimmed, sticker, makeTransport, browserStore);
      await saveSummary({
        roundId: link.roundId,
        name: latest.meta?.name ?? '',
        nickname: trimmed,
        revealAt: latest.meta?.revealAt ?? 0,
        linkSaved: false,
        slipPulled: false,
        cardsSeen: 0,
      });
      onJoined(client);
    } catch (error) {
      if (!(error instanceof OfflineError)) console.error(error);
      setProblem(copy.join.failed);
      setBusy(false);
    }
  };

  const suggestion = taken ? `${taken}2` : null;

  return (
    <>
      <Header />
      <main className="page">
        <Bag busy={false} />
        <h1 className="plain-heading">{copy.join.invitedTo(state.meta?.name ?? copy.brand)}</h1>
        <p>{copy.join.explain}</p>
        <InAppNotice url={absoluteLink(`#join=${link.roundId}.${link.secret}`)} />
        {full ? (
          <p role="alert">{copy.join.full}</p>
        ) : (
          <form
            className="panel stack"
            onSubmit={(event) => {
              event.preventDefault();
              void submit();
            }}
          >
            <label className="field">
              <span>{copy.join.nickname}</span>
              <input
                value={nickname}
                maxLength={20}
                autoComplete="off"
                onChange={(event) => {
                  setNickname(event.target.value);
                  setTaken(null);
                }}
              />
              <small className="note">{copy.join.nicknameHint}</small>
            </label>
            <fieldset>
              <legend>{copy.join.sticker}</legend>
              <StickerPicker value={sticker} onChange={setSticker} />
            </fieldset>
            {taken && (
              <div role="alert" className="stack">
                <p>{copy.join.taken(taken)}</p>
                <button type="button" className="btn btn-quiet" onClick={() => setNickname(suggestion ?? '')}>
                  {copy.join.useSuggestion(suggestion ?? '')}
                </button>
              </div>
            )}
            {problem && <p role="alert">{problem}</p>}
            <button type="submit" className="btn" disabled={busy}>
              {copy.join.submit}
            </button>
          </form>
        )}
        <button type="button" className="btn btn-quiet" onClick={() => setShowHowTo(true)}>
          {copy.join.howTo}
        </button>
      </main>
    </>
  );
}

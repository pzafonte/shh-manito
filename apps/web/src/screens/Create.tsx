import {
  DEFAULT_MAIL_TIMES,
  isValidBudget,
  OfflineError,
  PlayerClient,
  type StickerId,
} from '@shh-manito/protocol';
import { useState, type ReactNode } from 'react';
import { nextFridayEvening, toLocalInput } from '../browser';
import { Header, StickerPicker } from '../components';
import { makeTransport } from '../game';
import { useCopy } from '../i18n';
import { browserStore, saveSummary } from '../store';

const DEFAULT_BUDGET = '5000';
const MAX_REVEAL_AHEAD_MS = 60 * 24 * 60 * 60 * 1000;

export function Create({ onCreated, onBack }: { onCreated(client: PlayerClient): void; onBack(): void }): ReactNode {
  const copy = useCopy();
  const [name, setName] = useState(copy.create.defaultName);
  const [nickname, setNickname] = useState('');
  const [sticker, setSticker] = useState<StickerId | null>(null);
  const [revealAt, setRevealAt] = useState(() => toLocalInput(nextFridayEvening(new Date())));
  const [satsOn, setSatsOn] = useState(false);
  const [budget, setBudget] = useState(DEFAULT_BUDGET);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (): Promise<void> => {
    const trimmed = nickname.trim();
    if (!trimmed || !sticker) return setProblem(copy.create.missing);
    const reveal = new Date(revealAt).getTime();
    const now = Date.now();
    if (!(reveal > now) || reveal > now + MAX_REVEAL_AHEAD_MS) return setProblem(copy.create.revealBad);
    if (satsOn && (!isValidBudget(budget) || budget === '0')) return setProblem(copy.create.budgetBad);

    setBusy(true);
    setProblem(null);
    try {
      const client = await PlayerClient.create(
        {
          name: name.trim() || copy.create.defaultName,
          revealAt: reveal,
          timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
          mailTimes: [...DEFAULT_MAIL_TIMES],
          budget: satsOn ? budget : '0',
          nickname: trimmed,
          sticker,
        },
        makeTransport,
        browserStore,
      );
      await saveSummary({
        roundId: client.local.roundId,
        name: name.trim(),
        nickname: trimmed,
        revealAt: reveal,
        linkSaved: false,
        slipPulled: false,
        cardsSeen: 0,
      });
      onCreated(client);
    } catch (error) {
      if (!(error instanceof OfflineError)) console.error(error);
      setProblem(copy.create.failed);
      setBusy(false);
    }
  };

  return (
    <>
      <Header />
      <main className="page">
        <h1>{copy.create.title}</h1>
        <form
          className="panel stack"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <label className="field">
            <span>{copy.create.roundName}</span>
            <input value={name} maxLength={40} onChange={(event) => setName(event.target.value)} />
          </label>
          <label className="field">
            <span>{copy.create.nickname}</span>
            <input value={nickname} maxLength={20} autoComplete="off" onChange={(event) => setNickname(event.target.value)} />
          </label>
          <fieldset>
            <legend>{copy.create.sticker}</legend>
            <StickerPicker value={sticker} onChange={setSticker} />
          </fieldset>
          <label className="field">
            <span>{copy.create.revealAt}</span>
            <input type="datetime-local" value={revealAt} onChange={(event) => setRevealAt(event.target.value)} />
          </label>
          <label className="toggle">
            <input type="checkbox" checked={satsOn} onChange={(event) => setSatsOn(event.target.checked)} />
            <span>{copy.create.satsToggle}</span>
          </label>
          {satsOn && (
            <>
              <p className="note">{copy.create.satsNote}</p>
              <label className="field">
                <span>{copy.create.budget}</span>
                <input inputMode="numeric" value={budget} onChange={(event) => setBudget(event.target.value.trim())} />
              </label>
            </>
          )}
          {problem && <p role="alert">{problem}</p>}
          <button type="submit" className="btn" disabled={busy}>
            {copy.create.submit}
          </button>
        </form>
        <button type="button" className="btn btn-quiet" onClick={onBack}>
          {copy.problem.home}
        </button>
      </main>
    </>
  );
}

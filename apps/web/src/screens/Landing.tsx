import { parseLink } from '@shh-manito/protocol';
import { useState, type ReactNode } from 'react';
import { isKakaoInApp } from '../browser';
import { Header } from '../components';
import { useCopy } from '../i18n';
import type { RoundSummary } from '../store';
import { HowTo } from './Overlays';

export function PasteLink({
  label,
  go,
  bad,
  accept = 'any',
}: {
  label: string;
  go: string;
  bad: string;
  accept?: 'any' | 'me';
}): ReactNode {
  const [text, setText] = useState('');
  const [wrong, setWrong] = useState(false);
  return (
    <form
      className="stack"
      onSubmit={(event) => {
        event.preventDefault();
        const hash = /#.*/.exec(text.trim())?.[0] ?? text.trim();
        const link = parseLink(hash);
        if (!link || (accept === 'me' && link.kind !== 'me')) {
          setWrong(true);
          return;
        }
        location.hash = hash.startsWith('#') ? hash.slice(1) : hash;
      }}
    >
      <label className="field">
        <span>{label}</span>
        <input
          inputMode="url"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          autoComplete="off"
          value={text}
          onChange={(event) => {
            setText(event.target.value);
            setWrong(false);
          }}
        />
      </label>
      {wrong && <p role="alert">{bad}</p>}
      <button type="submit" className="btn btn-quiet" disabled={text.trim().length === 0}>
        {go}
      </button>
    </form>
  );
}

export function Landing({
  rounds,
  onCreate,
  onOpen,
}: {
  rounds: RoundSummary[];
  onCreate(): void;
  onOpen(roundId: string): void;
}): ReactNode {
  const copy = useCopy();
  const [showHowTo, setShowHowTo] = useState(false);
  if (showHowTo) return <HowTo satsOn={false} onClose={() => setShowHowTo(false)} />;
  return (
    <>
      <Header />
      <main className="page">
        <section className="hero">
          <h1>{copy.brand}</h1>
          <p>{copy.tagline}</p>
        </section>
        {isKakaoInApp() && (
          <section className="panel panel-warm">
            <h2>{copy.inApp.cutLinkTitle}</h2>
            <p>{copy.inApp.cutLinkBody}</p>
          </section>
        )}
        <button type="button" className="btn" onClick={onCreate}>
          {copy.landing.start}
        </button>
        {rounds.length > 0 && (
          <section className="panel">
            <h2>{copy.landing.yourRounds}</h2>
            <ul className="plain-list">
              {rounds.map((round) => (
                <li key={round.roundId}>
                  <button type="button" className="btn btn-quiet" onClick={() => onOpen(round.roundId)}>
                    {round.name || copy.landing.open}
                  </button>
                </li>
              ))}
            </ul>
          </section>
        )}
        <section className="panel">
          <h2>{copy.landing.haveLink}</h2>
          <PasteLink label={copy.landing.pasteLabel} go={copy.landing.pasteGo} bad={copy.landing.pasteBad} />
        </section>
        <button type="button" className="btn btn-quiet" onClick={() => setShowHowTo(true)}>
          {copy.landing.howTo}
        </button>
      </main>
    </>
  );
}

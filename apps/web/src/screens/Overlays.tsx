import { sha256, type LogEntry, type PlayerClient } from '@shh-manito/protocol';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { absoluteLink, formatTime, shareText } from '../browser';
import { CopyButton, LanguageButton } from '../components';
import { useCopy, useLanguage } from '../i18n';
import type { GameHandle } from '../game';

const LOG_ROWS_SHOWN = 40;
const HASH_PREFIX_BYTES = 6;

function Sheet({ title, onClose, dark, children }: { title: string; onClose(): void; dark?: boolean; children: ReactNode }): ReactNode {
  const copy = useCopy();
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    heading.current?.focus();
  }, []);
  return (
    <main className={dark ? 'page sheet sheet-dark' : 'page sheet'}>
      <div className="sheet-head">
        <h1 ref={heading} tabIndex={-1}>
          {title}
        </h1>
        <span className="topbar-actions">
          <LanguageButton />
          <button type="button" className="chip-button" onClick={onClose}>
            {copy.menu.close}
          </button>
        </span>
      </div>
      {children}
    </main>
  );
}

export function HowTo({ satsOn, onClose }: { satsOn: boolean; onClose(): void }): ReactNode {
  const { howTo } = useCopy();
  const steps = satsOn ? [...howTo.steps, howTo.satsStep] : howTo.steps;
  return (
    <Sheet title={howTo.title} onClose={onClose}>
      <ol className="how">
        {steps.map((step) => (
          <li key={step.title}>
            <span className="how-icon" aria-hidden="true">
              {step.icon}
            </span>
            <span>
              <b>{step.title}</b>
              <br />
              {step.body}
            </span>
          </li>
        ))}
      </ol>
    </Sheet>
  );
}

export function PersonalLinkPanel({ game }: { game: GameHandle }): ReactNode {
  const { personal } = useCopy();
  const url = absoluteLink(game.client.personalLink);
  return (
    <section className="panel panel-warm stack" aria-label={personal.title}>
      <h2>{personal.title}</h2>
      <p>{personal.why}</p>
      <p>
        <b>{personal.warning}</b>
      </p>
      <p className="note">{personal.saveHint}</p>
      <button
        type="button"
        className="btn"
        onClick={() => {
          void shareText(personal.shareText, url).then((result) => {
            if (result !== 'failed') game.updateSummary({ linkSaved: true });
          });
        }}
      >
        {personal.save}
      </button>
      <CopyButton text={url} label={personal.copy} done={personal.copied} />
      {!game.summary.linkSaved && (
        <button type="button" className="btn btn-quiet" onClick={() => game.updateSummary({ linkSaved: true })}>
          {personal.done}
        </button>
      )}
    </section>
  );
}

export function PersonalLinkSheet({ game, onClose }: { game: GameHandle; onClose(): void }): ReactNode {
  const { personal } = useCopy();
  return (
    <Sheet title={personal.title} onClose={onClose}>
      <PersonalLinkPanel game={game} />
    </Sheet>
  );
}

interface LogRow {
  entry: LogEntry;
  hash: string;
}

async function hashPrefix(entry: LogEntry): Promise<LogRow> {
  const digest = await sha256(entry.body);
  const hex = [...digest.slice(0, HASH_PREFIX_BYTES)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  return { entry, hash: hex };
}

export function ServerSees({ client, onClose }: { client: PlayerClient; onClose(): void }): ReactNode {
  const { serverSees: text } = useCopy();
  const { language } = useLanguage();
  const [rows, setRows] = useState<LogRow[]>([]);
  const total = client.entries.length;

  useEffect(() => {
    let current = true;
    void Promise.all(client.entries.slice(-LOG_ROWS_SHOWN).map(hashPrefix)).then((next) => {
      if (current) setRows(next.reverse());
    });
    return () => {
      current = false;
    };
  }, [client, total]);

  return (
    <Sheet title={text.title} onClose={onClose} dark>
      <p>{text.intro}</p>
      <section className="stack">
        <h2>{text.logTitle}</h2>
        {rows.length === 0 ? (
          <p>{text.empty}</p>
        ) : (
          <>
            <p className="note">{text.shows(rows.length, total)}</p>
            <div className="table-scroll" tabIndex={0} role="region" aria-label={text.logTitle}>
              <table className="log">
                <thead>
                  <tr>
                    <th scope="col">{text.columns.seq}</th>
                    <th scope="col">{text.columns.kind}</th>
                    <th scope="col">{text.columns.size}</th>
                    <th scope="col">{text.columns.hash}</th>
                    <th scope="col">{text.columns.mail}</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map(({ entry, hash }) => (
                    <tr key={entry.seq}>
                      <td>{entry.seq}</td>
                      <td>{entry.kind === 'group' ? text.group : text.sealed}</td>
                      <td>{text.bytes(entry.body.length.toLocaleString(language))}</td>
                      <td className="mono">{hash}</td>
                      <td>{entry.visibleAt ? formatTime(entry.visibleAt, language) : '–'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </section>
      <section className="stack">
        <h2>{text.canSeeTitle}</h2>
        <ul>
          {text.canSee.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      </section>
      <section className="stack">
        <h2>{text.cannotSeeTitle}</h2>
        <ul>
          {text.cannotSee.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      </section>
      <section className="stack">
        <h2>{text.leaksTitle}</h2>
        <ul>
          {(client.satsOn ? [...text.leaks, text.satsLeak] : text.leaks).map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
        <p className="note">{text.protocolLink}</p>
      </section>
    </Sheet>
  );
}

export function Menu({
  onPick,
  onClose,
}: {
  onPick(item: 'howTo' | 'personal' | 'server' | 'rounds'): void;
  onClose(): void;
}): ReactNode {
  const { menu } = useCopy();
  return (
    <Sheet title={menu.open} onClose={onClose}>
      <div className="stack">
        <button type="button" className="btn btn-quiet" onClick={() => onPick('howTo')}>
          {menu.howTo}
        </button>
        <button type="button" className="btn btn-quiet" onClick={() => onPick('personal')}>
          {menu.personal}
        </button>
        <button type="button" className="btn btn-quiet" onClick={() => onPick('server')}>
          {menu.server}
        </button>
        <button type="button" className="btn btn-quiet" onClick={() => onPick('rounds')}>
          {menu.allRounds}
        </button>
      </div>
    </Sheet>
  );
}


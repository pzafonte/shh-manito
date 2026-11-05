import {
  OfflineError,
  parseLink,
  PlayerClient,
  RoundGoneError,
  type RoundLink,
  type RoundState,
} from '@shh-manito/protocol';
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { phoneLanguage } from './browser';
import { Header, Trouble } from './components';
import { COPY, type Language } from './copy';
import { makeTransport } from './game';
import { LanguageContext, useCopy } from './i18n';
import { Create } from './screens/Create';
import { Game } from './screens/Game';
import { Join } from './screens/Join';
import { Landing } from './screens/Landing';
import { NoKeys } from './screens/NoKeys';
import {
  browserStore,
  listSummaries,
  loadLanguage,
  loadPlayer,
  saveLanguage,
  saveSummary,
  type RoundSummary,
} from './store';

type ProblemKind = 'gone' | 'badLink' | 'offline';

type Route =
  | { name: 'loading' }
  | { name: 'landing'; rounds: RoundSummary[] }
  | { name: 'create' }
  | { name: 'join'; link: RoundLink; state: RoundState }
  | { name: 'noKeys'; link: RoundLink }
  | { name: 'game'; client: PlayerClient }
  | { name: 'problem'; kind: ProblemKind };

function rememberRound(roundId: string): void {
  history.replaceState(null, '', `#r=${roundId}`);
}

async function openStored(roundId: string): Promise<Route | null> {
  const local = await loadPlayer(roundId);
  if (!local) return null;
  rememberRound(roundId);
  return { name: 'game', client: await PlayerClient.open(local, makeTransport, browserStore) };
}

async function restoreFromLink(link: RoundLink): Promise<Route> {
  const stored = await openStored(link.roundId);
  if (stored) return stored;
  const client = await PlayerClient.restore(link.roundId, link.secret, makeTransport, browserStore);
  if (!client) return { name: 'problem', kind: 'gone' };
  rememberRound(link.roundId);
  // Whoever opened this link has it already, so there is nothing to remind them of.
  await saveSummary({
    roundId: link.roundId,
    name: '',
    nickname: '',
    revealAt: 0,
    linkSaved: true,
    slipPulled: false,
    cardsSeen: 0,
  });
  return { name: 'game', client };
}

// Never treats a browser with no keys as a new player once the roster has locked.
async function followInvite(link: RoundLink): Promise<Route> {
  const stored = await openStored(link.roundId);
  if (stored) return stored;
  const state = await PlayerClient.peek(link.roundId, link.secret, makeTransport);
  return state.locked ? { name: 'noKeys', link } : { name: 'join', link, state };
}

async function route(): Promise<Route> {
  const fragment = location.hash;
  const link = parseLink(fragment);
  const remembered = /^#r=(.+)$/.exec(fragment)?.[1];

  if (fragment && fragment !== '#' && !link && !remembered) return { name: 'problem', kind: 'badLink' };
  try {
    if (link?.kind === 'me') return await restoreFromLink(link);
    if (link?.kind === 'join') return await followInvite(link);
  } catch (error) {
    if (error instanceof RoundGoneError) return { name: 'problem', kind: 'gone' };
    if (error instanceof OfflineError) return { name: 'problem', kind: 'offline' };
    throw error;
  }
  if (remembered) {
    const stored = await openStored(remembered);
    if (stored) return stored;
  }
  const rounds = await listSummaries();
  const [only] = rounds;
  if (rounds.length === 1 && only && !remembered) {
    const stored = await openStored(only.roundId);
    if (stored) return stored;
  }
  return { name: 'landing', rounds };
}

function Problem({ kind, onRetry }: { kind: ProblemKind; onRetry(): void }): ReactNode {
  const { problem } = useCopy();
  const text = {
    gone: [problem.goneTitle, problem.goneBody],
    badLink: [problem.badLinkTitle, problem.badLinkBody],
    offline: [problem.offlineTitle, problem.offlineBody],
  }[kind] as [string, string];
  return (
    <Trouble
      title={text[0]}
      body={text[1]}
      actions={
        <div className="stack">
          {kind === 'offline' && (
            <button type="button" className="btn" onClick={onRetry}>
              {problem.retry}
            </button>
          )}
          <a
            className="btn btn-quiet"
            href="#"
            onClick={() => {
              history.replaceState(null, '', location.pathname);
              onRetry();
            }}
          >
            {problem.home}
          </a>
        </div>
      }
    />
  );
}

export function App(): ReactNode {
  const [language, setLanguageState] = useState<Language>(phoneLanguage);
  const [current, setCurrent] = useState<Route>({ name: 'loading' });

  const reload = useCallback(() => {
    void route().then(setCurrent);
  }, []);

  useEffect(() => {
    void loadLanguage().then((saved) => {
      if (saved) setLanguageState(saved);
    });
    reload();
    window.addEventListener('hashchange', reload);
    return () => window.removeEventListener('hashchange', reload);
  }, [reload]);

  useEffect(() => {
    document.documentElement.lang = language;
    document.title = COPY[language].brand;
  }, [language]);

  const languageValue = useMemo(
    () => ({
      language,
      setLanguage: (next: Language) => {
        setLanguageState(next);
        void saveLanguage(next);
      },
    }),
    [language],
  );

  const openClient = useCallback((client: PlayerClient) => {
    rememberRound(client.local.roundId);
    setCurrent({ name: 'game', client });
  }, []);

  const goHome = useCallback(() => {
    history.replaceState(null, '', location.pathname);
    void listSummaries().then((rounds) => setCurrent({ name: 'landing', rounds }));
  }, []);

  let screen: ReactNode;
  switch (current.name) {
    case 'loading':
      screen = <Loading />;
      break;
    case 'landing':
      screen = (
        <Landing
          rounds={current.rounds}
          onCreate={() => setCurrent({ name: 'create' })}
          onOpen={(roundId) => {
            history.replaceState(null, '', `#r=${roundId}`);
            reload();
          }}
        />
      );
      break;
    case 'create':
      screen = <Create onCreated={openClient} onBack={goHome} />;
      break;
    case 'join':
      screen = <Join link={current.link} state={current.state} onJoined={openClient} />;
      break;
    case 'noKeys':
      screen = <NoKeys link={current.link} />;
      break;
    case 'game':
      screen = <Game key={current.client.local.roundId} client={current.client} onOpen={openClient} onHome={goHome} />;
      break;
    case 'problem':
      screen = (
        <>
          <Header />
          <main className="page">
            <Problem kind={current.kind} onRetry={reload} />
          </main>
        </>
      );
      break;
  }

  return <LanguageContext.Provider value={languageValue}>{screen}</LanguageContext.Provider>;
}

function Loading(): ReactNode {
  const { problem } = useCopy();
  return (
    <main className="page">
      <p className="center" role="status">
        {problem.loading}
      </p>
    </main>
  );
}

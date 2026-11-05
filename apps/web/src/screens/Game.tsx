import { MAX_PLAYERS, type PlayerClient } from '@shh-manito/protocol';
import { useEffect, useState, type ReactNode } from 'react';
import { Header, Trouble } from '../components';
import { useGame, type GameHandle } from '../game';
import { useCopy } from '../i18n';
import { forgetPlayer, storageBroken } from '../store';
import { HowTo, Menu, PersonalLinkSheet, ServerSees } from './Overlays';
import { DrawTab, Home, InboxTab, SendTab, type Tab } from './Play';
import { RevealTab, Stuck } from './Reveal';
import { Check, Draw, Waiting } from './Setup';

type Overlay = 'menu' | 'howTo' | 'personal' | 'server' | null;

const TABS: Tab[] = ['home', 'draw', 'send', 'inbox', 'reveal'];

function TabBar({ tab, onTab, unread }: { tab: Tab; onTab(tab: Tab): void; unread: number }): ReactNode {
  const { nav, navLabel } = useCopy();
  return (
    <nav className="tabs" aria-label={navLabel}>
      {TABS.map((name) => (
        <button
          key={name}
          type="button"
          className="tab"
          aria-current={tab === name ? 'page' : undefined}
          onClick={() => onTab(name)}
        >
          {nav[name]}
          {name === 'inbox' && unread > 0 ? ` (${unread})` : ''}
        </button>
      ))}
    </nav>
  );
}

function Playing({
  game,
  onOpen,
  onPersonal,
}: {
  game: GameHandle;
  onOpen(client: PlayerClient): void;
  onPersonal(): void;
}): ReactNode {
  const { client, summary } = game;
  const [tab, setTab] = useState<Tab>('home');
  const unread = Math.max(0, client.inbox.cards.length - summary.cardsSeen);

  useEffect(() => {
    window.scrollTo(0, 0);
  }, [tab]);

  return (
    <>
      <TabBar tab={tab} onTab={setTab} unread={unread} />
      {tab === 'home' && <Home game={game} unread={unread} onTab={setTab} onPersonal={onPersonal} />}
      {tab === 'draw' && <DrawTab game={game} />}
      {tab === 'send' && <SendTab game={game} />}
      {tab === 'inbox' && <InboxTab game={game} />}
      {tab === 'reveal' && <RevealTab game={game} onOpen={onOpen} />}
    </>
  );
}

function Phase({
  game,
  onOpen,
  onPersonal,
}: {
  game: GameHandle;
  onOpen(client: PlayerClient): void;
  onPersonal(): void;
}): ReactNode {
  const { client } = game;
  switch (client.phase) {
    case 'gathering':
      return <Waiting game={game} />;
    case 'checking':
      return <Check game={game} />;
    case 'drawing':
      return <Draw game={game} />;
    case 'stuck':
      return <Stuck game={game} onOpen={onOpen} />;
    case 'playing':
      return <Playing game={game} onOpen={onOpen} onPersonal={onPersonal} />;
  }
}

function LostName({ game }: { game: GameHandle }): ReactNode {
  const { problem, join } = useCopy();
  const { client } = game;
  const full = client.state.joined.length >= MAX_PLAYERS;
  return (
    <Trouble
      title={full ? join.full : problem.nameLostTitle}
      body={full ? '' : problem.nameLostBody}
      actions={
        !full && (
          <button
            type="button"
            className="btn"
            onClick={() => {
              const link = client.inviteLink;
              void forgetPlayer(client.local.roundId).then(() => {
                location.hash = link.slice(1);
              });
            }}
          >
            {problem.retry}
          </button>
        )
      }
    />
  );
}

export function Game({
  client,
  onOpen,
  onHome,
}: {
  client: PlayerClient;
  onOpen(client: PlayerClient): void;
  onHome(): void;
}): ReactNode {
  const copy = useCopy();
  const { problem } = copy;
  const game = useGame(client);
  const [overlay, setOverlay] = useState<Overlay>(null);

  if (overlay === 'howTo') return <HowTo satsOn={client.satsOn} onClose={() => setOverlay(null)} />;
  if (overlay === 'personal') return <PersonalLinkSheet game={game} onClose={() => setOverlay(null)} />;
  if (overlay === 'server') return <ServerSees client={client} onClose={() => setOverlay(null)} />;
  if (overlay === 'menu') {
    return (
      <Menu
        onClose={() => setOverlay(null)}
        onPick={(item) => {
          if (item === 'rounds') onHome();
          else setOverlay(item);
        }}
      />
    );
  }

  const homeButton = (
    <button type="button" className="btn btn-quiet" onClick={onHome}>
      {problem.home}
    </button>
  );

  let body: ReactNode;
  if (game.gone) {
    body = <Trouble title={problem.goneTitle} body={problem.goneBody} actions={homeButton} />;
  } else if (!client.synced) {
    body = (
      <p className="center" role="status">
        {client.offline ? problem.offlineBody : problem.loading}
      </p>
    );
  } else if (client.local.stopped) {
    body = <Trouble title={copy.check.stoppedTitle} body={copy.check.stoppedBody} actions={homeButton} />;
  } else if (client.membership === 'removed') {
    body = <Trouble title={problem.removedTitle} body={problem.removedBody} actions={homeButton} />;
  } else if (client.membership === 'left-out') {
    body = <Trouble title={problem.leftOutTitle} body={problem.leftOutBody} actions={homeButton} />;
  } else if (client.membership === 'waiting' && client.local.outbox.length === 0) {
    body = <LostName game={game} />;
  } else {
    body = <Phase game={game} onOpen={onOpen} onPersonal={() => setOverlay('personal')} />;
  }

  return (
    <>
      <Header onMenu={() => setOverlay('menu')} />
      <main className="page">
        {client.offline && client.synced && <p className="banner">{copy.home.offline}</p>}
        {client.scheduleTampered && (
          <p className="banner" role="alert">
            {copy.home.tampered}
          </p>
        )}
        {storageBroken && (
          <p className="banner" role="alert">
            {problem.storageBody}
          </p>
        )}
        {body}
      </main>
    </>
  );
}

import {
  httpTransport,
  PlayerClient,
  RoundGoneError,
  type Phase,
  type Transport,
} from '@shh-manito/protocol';
import { useEffect, useMemo, useReducer, useRef } from 'react';
import { loadSummary, saveSummary, type RoundSummary } from './store';

// Set only by the public phase of the round. Polling faster because of anything a
// phone privately knows would tell the server who a parcel was for.
const POLL_MS: Record<Phase, number> = {
  gathering: 2_500,
  checking: 800,
  drawing: 800,
  stuck: 5_000,
  playing: 5_000,
};

export function makeTransport(roundId: string, authToken: string): Transport {
  return httpTransport(location.origin, roundId, authToken);
}

export interface GameHandle {
  client: PlayerClient;
  summary: RoundSummary;
  gone: boolean;
  refresh(): void;
  act<T>(action: () => Promise<T>): Promise<T>;
  updateSummary(change: Partial<RoundSummary>): void;
}

function emptySummary(client: PlayerClient): RoundSummary {
  return {
    roundId: client.local.roundId,
    name: '',
    nickname: '',
    revealAt: 0,
    linkSaved: false,
    slipPulled: false,
    cardsSeen: 0,
  };
}

export function useGame(client: PlayerClient): GameHandle {
  const [, render] = useReducer((count: number) => count + 1, 0);
  const summary = useRef<RoundSummary>(emptySummary(client));
  const gone = useRef(false);
  const running = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const handle = useMemo(() => {
    const persist = (): void => void saveSummary(summary.current);

    const remember = (): void => {
      const meta = client.state.meta;
      const me = [...client.state.joined, ...client.state.roster].find((player) => player.fp === client.local.fp);
      if (!meta || !me) return;
      const next = { ...summary.current, name: meta.name, nickname: me.nickname, revealAt: meta.revealAt };
      if (next.name !== summary.current.name || next.nickname !== summary.current.nickname) {
        summary.current = next;
        persist();
      }
    };

    const run = async (): Promise<void> => {
      if (running.current) return;
      running.current = true;
      clearTimeout(timer.current);
      try {
        await client.tick();
        remember();
      } catch (error) {
        if (error instanceof RoundGoneError) gone.current = true;
        else throw error;
      } finally {
        running.current = false;
        render();
        if (!gone.current) timer.current = setTimeout(() => void run(), POLL_MS[client.phase]);
      }
    };

    return {
      run,
      updateSummary: (change: Partial<RoundSummary>): void => {
        summary.current = { ...summary.current, ...change };
        persist();
        render();
      },
      act: async <T,>(action: () => Promise<T>): Promise<T> => {
        try {
          const result = await action();
          render();
          void run();
          return result;
        } catch (error) {
          if (!(error instanceof RoundGoneError)) throw error;
          gone.current = true;
          render();
          // The screen has already changed to say the round ended, so whatever
          // was waiting on this tap has nothing left to do.
          return new Promise<T>(() => undefined);
        }
      },
    };
  }, [client]);

  useEffect(() => {
    let cancelled = false;
    void loadSummary(client.local.roundId).then((stored) => {
      if (cancelled) return;
      if (stored) summary.current = stored;
      void handle.run();
    });
    const wake = (): void => void handle.run();
    window.addEventListener('online', wake);
    document.addEventListener('visibilitychange', wake);
    return () => {
      cancelled = true;
      clearTimeout(timer.current);
      window.removeEventListener('online', wake);
      document.removeEventListener('visibilitychange', wake);
    };
  }, [client, handle]);

  return {
    client,
    summary: summary.current,
    gone: gone.current,
    refresh: () => void handle.run(),
    act: handle.act,
    updateSummary: handle.updateSummary,
  };
}

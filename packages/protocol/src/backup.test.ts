import { describe, expect, it } from 'vitest';
import { utf8 } from './bytes.js';
import { PlayerClient } from './client.js';
import { BACKUP_BLOB_BYTES } from './constants.js';
import { decryptBackup } from './envelopes.js';
import { deriveBackupSecrets, formatLink, parseLink } from './links.js';
import {
  assertOneCircle,
  drawnRound,
  FakeServer,
  fold,
  lockAndCheck,
  MemoryStore,
  NOW,
  openRound,
  organiser,
  settle,
  type SimPlayer,
} from './testing/harness.js';

const DAY_MS = 24 * 60 * 60 * 1000;

function restore(server: FakeServer, player: SimPlayer): Promise<PlayerClient | null> {
  const parsed = parseLink(player.client.personalLink)!;
  return PlayerClient.restore(parsed.roundId, parsed.secret, () => server.transport(`${player.name}-new`), new MemoryStore());
}

describe('links', () => {
  it('round-trip both kinds', () => {
    const link = { kind: 'me' as const, roundId: 'A'.repeat(21) + 'A', secret: 'B'.repeat(42) + 'A' };
    expect(parseLink(formatLink(link))).toEqual(link);
  });

  it('reject anything else', () => {
    for (const text of ['', '#', '#join=abc', '#other=x.y', '#join=short.short']) expect(parseLink(text)).toBeNull();
  });
});

describe('personal links', () => {
  it('every backup is the same size, whatever it holds', async () => {
    const server = new FakeServer();
    const players = await drawnRound(server, 4);
    await players[0]!.client.sendCard('lunch', '100', NOW);
    await settle(server, players);
    const sizes = [...server.backups.values()].map((blob) => blob.length);
    expect(new Set(sizes)).toEqual(new Set([BACKUP_BLOB_BYTES]));
    expect(sizes).toHaveLength(4);
  });

  it('a backup never contains a mix key', async () => {
    const server = new FakeServer();
    const players = await drawnRound(server, 4);
    const { client } = players[0]!;
    const secrets = await deriveBackupSecrets(client.local.roundId, client.local.meSecret);
    const content = await decryptBackup(secrets.backupKey, secrets.handle, server.backups.get(secrets.handle)!);
    expect(JSON.stringify(content)).not.toContain('mix');
  });

  it('restores slip, inbox and promises in a new browser', async () => {
    const server = new FakeServer();
    const players = await drawnRound(server, 4);
    const sender = players[0]!;
    const target = players.find(({ client }) => client.local.fp === sender.client.target!.fp)!;
    const senderOfCard = players.find(({ client }) => client.target?.fp === sender.client.local.fp)!;
    await sender.client.setGuess(target.client.local.fp);
    await sender.client.sendCard('coffee', '300', NOW);
    await senderOfCard.client.sendCard('smile', '200', NOW);
    server.now = NOW + DAY_MS;
    await settle(server, players);

    const restored = (await restore(server, sender))!;
    await restored.tick();
    expect(restored.target?.fp).toBe(sender.client.target!.fp);
    expect(restored.inbox.cards.map((card) => card.card)).toEqual(['smile']);
    expect(restored.promisedTotal).toBe(300n);
    expect(restored.local.guess).toBe(target.client.local.fp);
  });

  it('changing a guess causes no network activity at all (F15)', async () => {
    const server = new FakeServer();
    const players = await drawnRound(server, 4);
    const { client } = players[0]!;
    const { handle } = await deriveBackupSecrets(client.local.roundId, client.local.meSecret);
    const before = server.backups.get(handle);
    await client.setGuess(players[1]!.client.local.fp);
    await settle(server, players);
    expect(server.backups.get(handle)).toBe(before);
  });

  it('a wrong secret finds nothing', async () => {
    const server = new FakeServer();
    const players = await drawnRound(server, 4);
    const { roundId } = players[0]!.client.local;
    const other = 'A'.repeat(42) + 'A';
    const restored = await PlayerClient.restore(roundId, other, () => server.transport('x'), new MemoryStore());
    expect(restored).toBeNull();
  });

  it('a tampered backup does not open', async () => {
    const server = new FakeServer();
    const players = await drawnRound(server, 4);
    const { client } = players[0]!;
    const secrets = await deriveBackupSecrets(client.local.roundId, client.local.meSecret);
    const blob = server.backups.get(secrets.handle)!.slice();
    blob[40]! ^= 1;
    server.backups.set(secrets.handle, blob);
    expect(await restore(server, players[0]!)).toBeNull();
  });

  it('restoring mid-draw without a mix key restarts the attempt safely', async () => {
    const server = new FakeServer();
    const players = await openRound(server, 4);
    await lockAndCheck(server, players);
    await organiser(players).confirmMatch();
    const mixer = players[3]!;
    const atLastMixer = async (): Promise<boolean> => {
      const current = (await fold(organiser(players), server.log)).current;
      return current?.stage === 'mixing' && current.mixStep === 3;
    };
    for (let pass = 0; pass < 50 && !(await atLastMixer()); pass++) {
      for (const player of players.slice(0, 3)) await player.client.tick();
      if (!mixer.client.local.attempt?.done.onion) await mixer.client.tick();
    }
    expect(await atLastMixer()).toBe(true);
    const restored = (await restore(server, mixer))!;
    expect(restored.local.attempt?.mix ?? null).toBeNull();
    const survivors = [...players.slice(0, 3), { ...mixer, client: restored }];
    await settle(server, survivors);
    expect(organiser(players).state.final!.number).toBe(2);
    assertOneCircle(survivors);
  });

  it('a reload at any moment of the draw picks up where it left off', async () => {
    const server = new FakeServer();
    const players = await openRound(server, 4);
    await lockAndCheck(server, players);
    await organiser(players).confirmMatch();
    for (let pass = 0; pass < 60 && !organiser(players).state.final; pass++) {
      for (const player of players) {
        if (player.store.snapshot) {
          player.client = await PlayerClient.open(
            structuredClone(player.store.snapshot),
            () => server.transport(player.name),
            player.store,
          );
        }
        await player.client.tick();
      }
    }
    await settle(server, players);
    assertOneCircle(players);
    expect(organiser(players).state.final!.number).toBe(1);
  });

  it('keeps private keys out of reach of export', async () => {
    const server = new FakeServer();
    const players = await drawnRound(server, 4);
    const { local } = players[0]!.client;
    expect(local.identity.privateKey.extractable).toBe(false);
    expect(local.attempt!.box.ecdh.privateKey.extractable).toBe(false);
    expect(local.attempt!.box.ecdsa.privateKey.extractable).toBe(false);
    expect(local.attempt!.mix).toBeNull();
    expect(utf8(local.keyring).length).toBeGreaterThan(0);
  });
});

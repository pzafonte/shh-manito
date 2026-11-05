import type { RoundLink } from '@shh-manito/protocol';
import type { ReactNode } from 'react';
import { absoluteLink } from '../browser';
import { Header, InAppNotice } from '../components';
import { useCopy } from '../i18n';
import { PasteLink } from './Landing';

export function NoKeys({ link }: { link: RoundLink }): ReactNode {
  const copy = useCopy();
  const text = copy.noKeys;
  return (
    <>
      <Header />
      <main className="page">
        <h1>{text.title}</h1>
        <p>{text.body}</p>
        <InAppNotice url={absoluteLink(`#join=${link.roundId}.${link.secret}`)} />
        <section className="panel stack">
          <h2>{text.personalTitle}</h2>
          <p>{text.personalBody}</p>
          <PasteLink label={text.personalLabel} go={text.personalGo} bad={text.personalBad} accept="me" />
        </section>
        <section className="panel">
          <h2>{text.lateTitle}</h2>
          <p>{text.lateBody}</p>
        </section>
      </main>
    </>
  );
}

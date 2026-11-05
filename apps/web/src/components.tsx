import { STICKER_IDS, type Player, type StickerId } from '@shh-manito/protocol';
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { copyText, externalOpenUrl, isKakaoInApp, reducedMotion } from './browser';
import { STICKER_EMOJI } from './copy';
import { useCopy, useLanguage } from './i18n';

const PEEK_TAP_MS = 5_000;
const LONG_PRESS_MS = 300;
const COPIED_NOTE_MS = 2_000;

export function LanguageButton(): ReactNode {
  const copy = useCopy();
  const { language, setLanguage } = useLanguage();
  return (
    <button
      type="button"
      className="chip-button"
      aria-label={copy.languageToggleLabel}
      onClick={() => setLanguage(language === 'ko' ? 'en' : 'ko')}
    >
      {copy.languageToggle}
    </button>
  );
}

export function Header({ onMenu }: { onMenu?: () => void }): ReactNode {
  const copy = useCopy();
  return (
    <header className="topbar">
      <span className="brand">{copy.brand}</span>
      <span className="topbar-actions">
        <LanguageButton />
        {onMenu && (
          <button type="button" className="chip-button" onClick={onMenu}>
            {copy.menu.open}
          </button>
        )}
      </span>
    </header>
  );
}

export function Bag({ busy }: { busy: boolean }): ReactNode {
  const copy = useCopy();
  return (
    <svg className={busy ? 'bag bag-busy' : 'bag'} viewBox="0 0 260 170" role="img" aria-label={copy.draw.bagAlt}>
      <rect className="bag-slip" x="92" y="6" width="34" height="46" rx="2" transform="rotate(-9 109 29)" />
      <rect className="bag-slip" x="130" y="10" width="34" height="42" rx="2" transform="rotate(8 147 31)" />
      <rect className="bag-top" x="30" y="40" width="200" height="30" />
      <rect className="bag-slit" x="80" y="50" width="100" height="9" rx="4" />
      <rect className="bag-front" x="30" y="70" width="200" height="94" />
      <text className="bag-label" x="130" y="127">
        {copy.draw.bagLabel}
      </text>
    </svg>
  );
}

export function Sticker({ id, label }: { id: StickerId; label?: string }): ReactNode {
  return (
    <span className="sticker" role={label ? 'img' : undefined} aria-label={label} aria-hidden={label ? undefined : true}>
      {STICKER_EMOJI[id]}
    </span>
  );
}

export function StickerPicker({
  value,
  onChange,
}: {
  value: StickerId | null;
  onChange(sticker: StickerId): void;
}): ReactNode {
  const copy = useCopy();
  const name = useId();
  return (
    <div className="stickers">
      {STICKER_IDS.map((id) => (
        <label key={id} className="sticker-option">
          <input type="radio" name={name} checked={value === id} onChange={() => onChange(id)} aria-label={copy.stickers[id]} />
          <span aria-hidden="true">{STICKER_EMOJI[id]}</span>
        </label>
      ))}
    </div>
  );
}

export function CopyButton({
  text,
  label,
  done,
  className = 'btn btn-quiet',
}: {
  text: string;
  label: string;
  done: string;
  className?: string;
}): ReactNode {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  return (
    <button
      type="button"
      className={className}
      onClick={() => {
        void copyText(text).then((ok) => {
          if (!ok) return;
          setCopied(true);
          clearTimeout(timer.current);
          timer.current = setTimeout(() => setCopied(false), COPIED_NOTE_MS);
        });
      }}
    >
      {copied ? `✓ ${done}` : label}
    </button>
  );
}

export function QrCode({ text, alt, size = 320 }: { text: string; alt: string; size?: number }): ReactNode {
  const [image, setImage] = useState<string | null>(null);
  useEffect(() => {
    let current = true;
    void import('qrcode').then(({ toDataURL }) =>
      toDataURL(text, { width: size, margin: 2, errorCorrectionLevel: 'M' }).then((url) => {
        if (current) setImage(url);
      }),
    );
    return () => {
      current = false;
    };
  }, [text, size]);
  return image ? <img className="qr" src={image} alt={alt} width={size} height={size} /> : null;
}

// The name only exists in the page while the slip is open, so nothing on screen or
// in the accessibility tree gives it away to someone looking over a shoulder.
export function Slip({ target, unfold = false }: { target: Player | null; unfold?: boolean }): ReactNode {
  const copy = useCopy();
  const [open, setOpen] = useState(false);
  const pressedAt = useRef(0);
  const closer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const held = useRef(false);

  useEffect(() => () => clearTimeout(closer.current), []);

  const close = (): void => {
    clearTimeout(closer.current);
    setOpen(false);
  };

  const showFor = (ms: number): void => {
    setOpen(true);
    clearTimeout(closer.current);
    closer.current = setTimeout(() => setOpen(false), ms);
  };

  if (!target) return <p className="note">{copy.slip.lost}</p>;

  return (
    <div className={`slip${unfold ? ' slip-unfold' : ''}`}>
      <span>{copy.slip.lookingAfter}</span>
      <button
        type="button"
        className="slip-peek"
        aria-label={copy.slip.peekLabel}
        aria-expanded={open}
        onPointerDown={() => {
          pressedAt.current = Date.now();
          held.current = true;
          setOpen(true);
          clearTimeout(closer.current);
        }}
        onPointerUp={() => {
          if (!held.current) return;
          held.current = false;
          if (Date.now() - pressedAt.current >= LONG_PRESS_MS) close();
          else showFor(PEEK_TAP_MS);
        }}
        onPointerLeave={() => {
          if (held.current) {
            held.current = false;
            close();
          }
        }}
        onContextMenu={(event) => event.preventDefault()}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            showFor(PEEK_TAP_MS);
          }
        }}
      >
        {open ? <span className="slip-name">{target.nickname}</span> : <span className="slip-folded">{copy.slip.yourPerson}</span>}
      </button>
      <span role="status" className="sr-only">
        {open ? target.nickname : ''}
      </span>
      <span className="note">{open ? copy.slip.secretNote : `${copy.slip.peekHold} · ${copy.slip.peekTap}`}</span>
    </div>
  );
}

export function InAppNotice({ url }: { url: string }): ReactNode {
  const copy = useCopy();
  if (!isKakaoInApp()) return null;
  return (
    <section className="panel panel-warm">
      <h2>{copy.inApp.title}</h2>
      <p>{copy.inApp.body}</p>
      <a className="btn btn-quiet" href={externalOpenUrl(url)}>
        {copy.inApp.openOutside}
      </a>
      <p className="note">{copy.inApp.manual}</p>
    </section>
  );
}

export function Trouble({
  title,
  body,
  actions,
}: {
  title: string;
  body: string;
  actions?: ReactNode;
}): ReactNode {
  return (
    <section className="panel" role="alert">
      <h1>{title}</h1>
      <p>{body}</p>
      {actions}
    </section>
  );
}

export function useReducedMotion(): boolean {
  const [value] = useState(reducedMotion);
  return value;
}

/**
 * File picker + import progress (§6.2). Parsing runs in a Web Worker, so
 * this only marshals state for the UI.
 */

import { useRef, useState } from 'react';
import { useLibraryStore } from '../state/library';
import { BookExistsError, importFile } from '../import/importService';

type Stage = 'parsing' | 'saving' | 'uploading' | 'done';

const STAGE_LABEL: Record<Stage, string> = {
  parsing: 'Parsing book…',
  saving: 'Saving locally…',
  uploading: 'Uploading to server…',
  done: 'Done',
};

export function ImportButton() {
  const refresh = useLibraryStore((s) => s.refresh);
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [stage, setStage] = useState<Stage | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const pick = (): void => {
    setNotice(null);
    inputRef.current?.click();
  };

  const onChange = async (ev: React.ChangeEvent<HTMLInputElement>): Promise<void> => {
    const file = ev.target.files?.[0];
    ev.target.value = ''; // allow re-picking the same file
    if (!file) return;
    setBusy(true);
    setNotice(null);
    try {
      const book = await importFile(file, { onStage: setStage });
      await refresh();
      if (book.pendingSync === 1) {
        setNotice('Imported. It will sync to the server when you are online.');
      }
    } catch (err) {
      if (err instanceof BookExistsError) setNotice(err.message);
      else setNotice(`Import failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusy(false);
      setStage(null);
    }
  };

  return (
    <div className="flex flex-col items-start gap-2">
      <input
        ref={inputRef}
        type="file"
        accept=".epub,.txt,application/epub+zip,text/plain"
        className="hidden"
        onChange={(ev) => void onChange(ev)}
        disabled={busy}
      />
      <button
        type="button"
        onClick={pick}
        disabled={busy}
        className="flex h-11 items-center gap-2 rounded-md bg-accent px-4 text-sm font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-60"
      >
        <ImportIcon />
        {busy && stage ? STAGE_LABEL[stage] : 'Import book'}
      </button>
      {notice && <p className="max-w-sm text-xs text-muted">{notice}</p>}
    </div>
  );
}

function ImportIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M8 2v8m0 0 3-3M8 10 5 7M3 12v1a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1v-2"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

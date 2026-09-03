/**
 * Library (§6.1): cover grid with progress, import button, empty state.
 */

import { useEffect } from 'react';
import { Link } from 'react-router-dom';
import { BookCard } from '../components/BookCard';
import { ImportButton } from '../components/ImportButton';
import { useLibraryStore } from '../state/library';
import { useSyncStatus } from '../sync/engine';

export function LibraryScreen() {
  const books = useLibraryStore((s) => s.books);
  const loading = useLibraryStore((s) => s.loading);
  const refresh = useLibraryStore((s) => s.refresh);
  const online = useSyncStatus((s) => s.online);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return (
    <div className="mx-auto min-h-dvh w-full max-w-3xl px-5 pb-16 pt-8">
      <header className="mb-8 flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="font-serif text-3xl text-fg">Library</h1>
          <p className="mt-1 text-sm text-muted">
            {books.length === 0 ? 'No books yet' : `${books.length} ${books.length === 1 ? 'book' : 'books'}`}
            {!online && <span className="ml-2 text-amber-700 dark:text-amber-400">· offline</span>}
          </p>
        </div>
        <div className="flex items-start gap-2">
          <Link
            to="/settings"
            aria-label="Settings"
            title="Settings"
            className="flex h-11 w-11 items-center justify-center rounded-md border border-black/15 text-fg hover:bg-black/5 dark:border-white/20 dark:hover:bg-white/5"
          >
            <OptionsIcon />
          </Link>
          <ImportButton />
        </div>
      </header>

      {loading ? (
        <p className="mt-16 text-center text-sm text-muted">Loading…</p>
      ) : books.length === 0 ? (
        <EmptyState />
      ) : (
        <div className="grid grid-cols-2 gap-x-4 gap-y-6 sm:grid-cols-3 md:grid-cols-4">
          {books.map((book) => (
            <BookCard key={book.id} book={book} />
          ))}
        </div>
      )}
    </div>
  );
}

function OptionsIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M4 7h9M17.5 7H20M4 12h3M11.5 12H20M4 17h9M17.5 17H20"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
      />
      <circle cx="15" cy="7" r="2.1" stroke="currentColor" strokeWidth="1.6" />
      <circle cx="9" cy="12" r="2.1" stroke="currentColor" strokeWidth="1.6" />
      <circle cx="15" cy="17" r="2.1" stroke="currentColor" strokeWidth="1.6" />
    </svg>
  );
}

function EmptyState() {
  return (
    <div className="mt-16 flex flex-col items-center gap-4 rounded-lg border border-dashed border-black/15 px-6 py-14 text-center dark:border-white/15">
      <svg width="40" height="40" viewBox="0 0 24 24" fill="none" className="text-muted">
        <path
          d="M4 5.5A2.5 2.5 0 0 1 6.5 3H12v16H6.5A2.5 2.5 0 0 0 4 21.5V5.5ZM12 3h5.5A2.5 2.5 0 0 1 20 5.5v16a2.5 2.5 0 0 0-2.5-2.5H12"
          stroke="currentColor"
          strokeWidth="1.4"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
      <h2 className="font-serif text-xl text-fg">Your shelf is empty</h2>
      <p className="max-w-sm text-sm text-muted">
        Import an EPUB or TXT file to start reading. Everything is stored on this device first, so
        your books work offline — and sync to your other devices when a server is configured.
      </p>
      <Link to="/settings" className="mt-2 text-sm text-accent underline underline-offset-4">
        Connect a server in Settings →
      </Link>
    </div>
  );
}

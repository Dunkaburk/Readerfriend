/**
 * One library grid tile: cover, title/author, reading progress, overflow
 * menu with delete. Touch targets ≥44px (§10).
 */

import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { BookCover } from './BookCover';
import { deleteBook } from '../import/importService';
import { useLibraryStore, type BookWithProgress } from '../state/library';

export function BookCard({ book }: { book: BookWithProgress }) {
  const navigate = useNavigate();
  const refresh = useLibraryStore((s) => s.refresh);
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const btnRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!menuOpen) return;
    // Dismiss on any press outside the menu — but not on the toggle button
    // itself (its click toggles; a pointerdown-close here would fight it).
    // pointerdown covers touch and mouse; Escape covers keyboards.
    const close = (ev: PointerEvent): void => {
      const target = ev.target as Node | null;
      if (menuRef.current?.contains(target) || btnRef.current?.contains(target)) return;
      setMenuOpen(false);
    };
    const onKey = (ev: KeyboardEvent): void => {
      if (ev.key === 'Escape') setMenuOpen(false);
    };
    document.addEventListener('pointerdown', close);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', close);
      document.removeEventListener('keydown', onKey);
    };
  }, [menuOpen]);

  const onDelete = async (): Promise<void> => {
    setMenuOpen(false);
    if (!window.confirm(`Remove “${book.title}” from your library?`)) return;
    await deleteBook(book.id);
    await refresh();
  };

  return (
    <div className="group relative">
      <Link
        to={`/book/${book.id}`}
        className="relative block overflow-hidden rounded-md shadow-sm ring-1 ring-black/5 transition-shadow hover:shadow-md focus-visible:outline-2 focus-visible:outline-accent"
        style={{ aspectRatio: '2 / 3' }}
      >
        <BookCover book={book} />
        {book.progressPct !== null && (
          <div className="absolute inset-x-0 bottom-0 h-1 bg-black/10">
            <div className="h-full bg-accent" style={{ width: `${Math.round(book.progressPct * 100)}%` }} />
          </div>
        )}
      </Link>

      <button
        ref={btnRef}
        type="button"
        aria-label={`Options for ${book.title}`}
        aria-expanded={menuOpen}
        className="absolute right-1.5 top-1.5 flex h-11 w-11 items-center justify-center rounded-full bg-black/45 text-white shadow-sm hover:bg-black/65"
        onClick={(ev) => {
          ev.preventDefault();
          setMenuOpen((o) => !o);
        }}
      >
        ⋯
      </button>

      {menuOpen && (
        <div
          ref={menuRef}
          className="absolute right-1.5 top-14 z-10 min-w-40 overflow-hidden rounded-md bg-surface py-1 shadow-lg ring-1 ring-black/10"
        >
          <button
            type="button"
            className="block w-full px-3 py-3 text-left text-sm text-fg hover:bg-black/5"
            onClick={() => {
              setMenuOpen(false);
              void navigate(`/book/${book.id}`);
            }}
          >
            Open
          </button>
          <button
            type="button"
            className="block w-full px-3 py-3 text-left text-sm text-red-700 hover:bg-black/5"
            onClick={() => void onDelete()}
          >
            Delete
          </button>
        </div>
      )}

      <div className="mt-2 px-0.5">
        <div className="truncate text-sm font-medium text-fg" title={book.title}>
          {book.title}
        </div>
        <div className="truncate text-xs text-muted">{book.author ?? 'Unknown author'}</div>
      </div>
    </div>
  );
}

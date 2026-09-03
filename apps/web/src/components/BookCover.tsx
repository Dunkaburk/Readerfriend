/**
 * Cover thumbnail. Loads the cover blob into an object URL; falls back to a
 * quiet typographic placeholder (one accent colour, §10).
 */

import { useEffect, useState } from 'react';
import { blobStore } from '../adapters/blobStore.dexie';
import type { BookWithProgress } from '../state/library';

export function BookCover({ book }: { book: BookWithProgress }) {
  const [url, setUrl] = useState<string | null>(null);

  useEffect(() => {
    if (!book.coverKey) return;
    let alive = true;
    const made: string[] = [];
    void blobStore.get(book.coverKey).then((blob) => {
      if (!blob || !alive) return;
      const u = URL.createObjectURL(blob);
      made.push(u);
      setUrl(u);
    });
    return () => {
      alive = false;
      for (const u of made) URL.revokeObjectURL(u);
    };
  }, [book.coverKey]);

  if (url) {
    return <img src={url} alt="" className="h-full w-full object-cover" loading="lazy" />;
  }
  return (
    <div className="flex h-full w-full flex-col items-center justify-center gap-1 bg-surface p-3 text-center">
      <span className="font-serif text-2xl leading-tight text-fg">{initials(book.title)}</span>
    </div>
  );
}

function initials(title: string): string {
  const words = title.split(/\s+/).filter((w) => /[a-z0-9]/i.test(w));
  return words
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join('');
}

/**
 * Reading-appearance drawer (§6.1, §10): the "Aa" quick panel in the reader —
 * theme, typeface, size/line-height/margins, sentence highlight — without
 * leaving the book. Narration and sync settings stay on the Settings screen
 * (linked in the footer).
 */

import { Link } from 'react-router-dom';
import { useSettingsStore } from '../state/settings';

interface AppearanceDrawerProps {
  open: boolean;
  onClose(): void;
}

const THEMES = [
  { id: 'light', label: 'Light' },
  { id: 'sepia', label: 'Sepia' },
  { id: 'dark', label: 'Dark' },
] as const;

const FACES = [
  { id: 'serif', label: 'Serif' },
  { id: 'sans', label: 'Sans' },
] as const;

export function AppearanceDrawer({ open, onClose }: AppearanceDrawerProps) {
  const settings = useSettingsStore((s) => s.settings);
  const update = useSettingsStore((s) => s.update);
  if (!open) return null;

  return (
    <div className="fixed inset-0 z-40" role="dialog" aria-label="Reading appearance">
      <button
        type="button"
        aria-label="Close appearance panel"
        onClick={onClose}
        className="absolute inset-0 h-full w-full cursor-default bg-black/30"
      />
      <aside className="absolute inset-y-0 right-0 flex w-80 max-w-[85vw] flex-col bg-surface shadow-xl">
        <div className="flex h-14 shrink-0 items-center justify-between border-b border-black/10 px-4 dark:border-white/10">
          <h2 className="text-sm font-medium text-fg">Reading appearance</h2>
          <button
            type="button"
            onClick={onClose}
            className="flex h-11 w-11 items-center justify-center text-muted hover:text-fg"
            aria-label="Close"
          >
            ✕
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-4 pt-4">
          <ChoiceRow
            label="Theme"
            options={THEMES}
            value={settings.theme}
            onSelect={(theme) => update({ theme })}
          />
          <ChoiceRow
            label="Typeface"
            options={FACES}
            value={settings.fontFamily}
            onSelect={(fontFamily) => update({ fontFamily })}
          />
          <SliderRow
            id="ap-font-size"
            label={`Font size — ${settings.fontSize}px`}
            min={14}
            max={28}
            step={1}
            value={settings.fontSize}
            onChange={(fontSize) => update({ fontSize })}
          />
          <SliderRow
            id="ap-line-height"
            label={`Line height — ${settings.lineHeight.toFixed(2)}`}
            min={1.3}
            max={2.2}
            step={0.05}
            value={settings.lineHeight}
            onChange={(lineHeight) => update({ lineHeight })}
          />
          <SliderRow
            id="ap-margin-width"
            label={`Margin width — ${settings.marginWidth}px`}
            min={12}
            max={64}
            step={4}
            value={settings.marginWidth}
            onChange={(marginWidth) => update({ marginWidth })}
          />
          <label className="mt-4 flex min-h-11 items-center gap-3 text-sm text-fg">
            <input
              type="checkbox"
              checked={settings.sentenceHighlight}
              onChange={(ev) => update({ sentenceHighlight: ev.target.checked })}
              className="h-4 w-4 accent-[var(--accent)]"
            />
            Highlight the current sentence while listening
          </label>
        </div>

        <div className="shrink-0 border-t border-black/10 px-4 py-3 dark:border-white/10">
          <Link
            to="/settings"
            onClick={onClose}
            className="inline-flex h-11 items-center text-sm text-accent underline underline-offset-4"
          >
            All settings →
          </Link>
        </div>
      </aside>
    </div>
  );
}

function ChoiceRow<T extends string>(props: {
  label: string;
  options: ReadonlyArray<{ id: T; label: string }>;
  value: T;
  onSelect(id: T): void;
}) {
  return (
    <div className="mb-4">
      <p className="text-xs uppercase tracking-wide text-muted">{props.label}</p>
      <div className="mt-2 flex flex-wrap gap-2" role="group" aria-label={props.label}>
        {props.options.map((o) => (
          <button
            key={o.id}
            type="button"
            onClick={() => props.onSelect(o.id)}
            aria-pressed={props.value === o.id}
            className={
              'h-11 rounded-md px-4 text-sm ' +
              (props.value === o.id
                ? 'bg-accent text-white'
                : 'border border-black/15 text-fg hover:bg-black/5 dark:border-white/20 dark:hover:bg-white/5')
            }
          >
            {o.label}
          </button>
        ))}
      </div>
    </div>
  );
}

function SliderRow(props: {
  id: string;
  label: string;
  min: number;
  max: number;
  step: number;
  value: number;
  onChange(v: number): void;
}) {
  return (
    <div className="mb-4">
      <label className="block text-sm text-fg" htmlFor={props.id}>
        {props.label}
      </label>
      <input
        id={props.id}
        type="range"
        min={props.min}
        max={props.max}
        step={props.step}
        value={props.value}
        onChange={(ev) => props.onChange(Number(ev.target.value))}
        className="mt-2 w-full accent-[var(--accent)]"
      />
    </div>
  );
}

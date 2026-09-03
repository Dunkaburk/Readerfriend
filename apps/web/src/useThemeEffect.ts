import { useEffect } from 'react';
import { applyThemeToDocument, useSettingsStore } from './state/settings';

/** Keep <html data-theme> in step with the persisted setting. */
export function useThemeEffect(): void {
  const theme = useSettingsStore((s) => s.settings.theme);
  useEffect(() => {
    applyThemeToDocument(theme);
  }, [theme]);
}

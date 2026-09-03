import { BrowserRouter, Route, Routes } from 'react-router-dom';
import { LibraryScreen } from './screens/LibraryScreen';
import { ReaderScreen } from './screens/ReaderScreen';
import { SettingsScreen } from './screens/SettingsScreen';
import { useThemeEffect } from './useThemeEffect';

export function App() {
  useThemeEffect();

  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<LibraryScreen />} />
        <Route path="/book/:bookId" element={<ReaderScreen />} />
        <Route path="/settings" element={<SettingsScreen />} />
      </Routes>
    </BrowserRouter>
  );
}

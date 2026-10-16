import { lazy, Suspense, useEffect } from "react";
import { Navigate, Route, Routes } from "react-router";
import { AppShell } from "./app/AppShell";
import { TooltipProvider } from "./components/ui";
import { LoadingState } from "./components/ui";
import { flushPendingRuns } from "./game/runLog";
import { DeckScreen } from "./screens/DeckScreen";
import { FlashcardImport } from "./screens/FlashcardImport";
import { HistoryScreen } from "./screens/history/HistoryScreen";
import { Home } from "./screens/Home";
import { ImportProgress } from "./screens/ImportProgress";
import { SessionSetup } from "./screens/SessionSetup";
import { SettingsScreen } from "./screens/SettingsScreen";

// Игра тянет three.js и R3F — грузим её только при старте забега.
const PlayScreen = lazy(() => import("./screens/PlayScreen"));

export function App() {
  // Забеги, сохранённые офлайн, уходят на сервер при следующем запуске.
  useEffect(() => {
    void flushPendingRuns();
  }, []);

  return (
    <TooltipProvider>
      <Routes>
        <Route element={<AppShell />}>
          <Route index element={<Home />} />
          <Route path="import/:jobId" element={<ImportProgress />} />
          <Route path="decks/:deckId" element={<DeckScreen />} />
          <Route path="decks/:deckId/setup" element={<SessionSetup />} />
          <Route path="history" element={<HistoryScreen />} />
          <Route path="settings" element={<SettingsScreen />} />
          <Route path="flashcards" element={<FlashcardImport />} />
        </Route>
        <Route
          path="play/:deckId"
          element={(
            <Suspense fallback={<div className="play-loading"><LoadingState label="Готовлю трассу…" /></div>}>
              <PlayScreen />
            </Suspense>
          )}
        />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </TooltipProvider>
  );
}

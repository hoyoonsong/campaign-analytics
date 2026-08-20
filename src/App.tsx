import { lazy, Suspense } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import { Layout } from './components/Layout';
import { ProtectedRoute } from './components/ProtectedRoute';
import { Spinner } from './components/ui';

const AuthBridge = lazy(() => import('./pages/AuthBridge'));
const Analytics = lazy(() => import('./pages/Analytics'));
const Search = lazy(() => import('./pages/Search'));
const ImportPage = lazy(() => import('./pages/Import'));
const Petitions = lazy(() => import('./pages/Petitions'));
const TrackingPolls = lazy(() => import('./pages/TrackingPolls'));
const Universes = lazy(() => import('./pages/Universes'));
const ContactSuggestions = lazy(() => import('./pages/ContactSuggestions'));
const Usage = lazy(() => import('./pages/Usage'));
const ActivityLogs = lazy(() => import('./pages/ActivityLogs'));

export default function App() {
  return (
    <Suspense fallback={<Spinner label="Loading…" />}>
      <Routes>
        <Route path="/auth/bridge" element={<AuthBridge />} />

        <Route
          element={
            <ProtectedRoute>
              <Layout />
            </ProtectedRoute>
          }
        >
          <Route path="/" element={<Analytics />} />
          <Route path="/search" element={<Search />} />
          <Route path="/suggestions" element={<ContactSuggestions />} />
          <Route path="/import" element={<ImportPage />} />
          <Route path="/petitions" element={<Petitions />} />
          <Route path="/tracking" element={<TrackingPolls />} />
          <Route path="/universes" element={<Universes />} />
          <Route path="/usage" element={<Usage />} />
          <Route path="/logs" element={<ActivityLogs />} />
        </Route>

        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </Suspense>
  );
}

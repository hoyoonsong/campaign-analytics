import { useState, type ReactNode } from 'react';
import { useAuth } from '../context/AuthContext';
import { Alert, Spinner } from './ui';

export function ProtectedRoute({ children }: { children: ReactNode }) {
  const {
    session,
    profile,
    loading,
    profileChecked,
    signOut,
    goToPortalLogin,
    signInWithGoogle,
    signInWithPassword,
  } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (loading || (session && !profileChecked && !profile)) {
    return <Spinner label="Loading…" />;
  }

  if (!session) {
    return (
      <div className="flex min-h-screen items-center justify-center px-4">
        <div className="card w-full max-w-md space-y-4 p-6">
          <div className="text-center">
            <img
              src="/achilles-logo-v2.png"
              alt="Todd Achilles for US Senate"
              className="mx-auto h-16 w-auto"
            />
            <h1 className="mt-4 text-lg font-semibold text-slate-900">
              Voter Analytics
            </h1>
            <p className="mt-1 text-sm text-slate-600">
              Use your campaign portal account. Same credentials — no separate signup.
            </p>
          </div>

          {error && <Alert variant="error">{error}</Alert>}

          <button
            type="button"
            className="btn-secondary w-full"
            disabled={busy}
            onClick={() => {
              setError(null);
              setBusy(true);
              void signInWithGoogle().then(({ error: err }) => {
                if (err) {
                  setError(err);
                  setBusy(false);
                }
              });
            }}
          >
            Continue with Google
          </button>

          <div className="relative py-1 text-center text-xs text-slate-400">
            <span className="bg-white px-2">or email</span>
          </div>

          <form
            className="space-y-3"
            onSubmit={(e) => {
              e.preventDefault();
              setError(null);
              setBusy(true);
              void signInWithPassword(email, password).then(({ error: err }) => {
                setBusy(false);
                if (err) setError(err);
              });
            }}
          >
            <div>
              <label className="label" htmlFor="email">
                Email
              </label>
              <input
                id="email"
                type="email"
                autoComplete="email"
                className="input"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
              />
            </div>
            <div>
              <label className="label" htmlFor="password">
                Password
              </label>
              <input
                id="password"
                type="password"
                autoComplete="current-password"
                className="input"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
              />
            </div>
            <button type="submit" className="btn-primary w-full" disabled={busy}>
              {busy ? 'Signing in…' : 'Sign in'}
            </button>
          </form>

          <button
            type="button"
            className="btn-ghost w-full text-xs"
            onClick={goToPortalLogin}
          >
            Or continue via campaign portal
          </button>
        </div>
      </div>
    );
  }

  if (!profile) {
    return (
      <div className="flex min-h-screen items-center justify-center px-4">
        <div className="card w-full max-w-md space-y-4 p-6 text-center">
          <img
            src="/achilles-logo-v2.png"
            alt="Todd Achilles for US Senate"
            className="mx-auto h-16 w-auto"
          />
          <h1 className="text-lg font-semibold text-slate-900">No team account</h1>
          <p className="text-sm text-slate-600">
            You&apos;re signed in, but you don&apos;t have access to this campaign
            workspace yet. Ask an admin to invite you, then try again.
          </p>
          {session.user.email && (
            <p className="text-xs text-slate-500">Signed in as {session.user.email}</p>
          )}
          <button type="button" className="btn-primary w-full" onClick={() => signOut()}>
            Sign out
          </button>
        </div>
      </div>
    );
  }

  return <>{children}</>;
}

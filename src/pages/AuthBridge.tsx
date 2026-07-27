import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { supabase } from '../lib/supabase';
import { Alert, Spinner } from '../components/ui';

/**
 * Receives a session via:
 * - Portal handoff hash tokens (#access_token=&refresh_token=)
 * - Google OAuth PKCE redirect (?code=) handled by detectSessionInUrl
 */
export default function AuthBridge() {
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    let finished = false;

    const goHome = () => {
      if (!active || finished) return;
      finished = true;
      window.history.replaceState(null, '', '/auth/bridge');
      navigate('/', { replace: true });
    };

    async function run() {
      const hash = window.location.hash.replace(/^#/, '');
      const hashParams = new URLSearchParams(hash);
      const queryParams = new URLSearchParams(window.location.search);
      const urlError =
        hashParams.get('error_description') ??
        hashParams.get('error') ??
        queryParams.get('error_description') ??
        queryParams.get('error');

      if (urlError) {
        if (active) setError(decodeURIComponent(urlError));
        return;
      }

      const access_token = hashParams.get('access_token');
      const refresh_token = hashParams.get('refresh_token');

      if (access_token && refresh_token) {
        const { error: setErr } = await supabase.auth.setSession({
          access_token,
          refresh_token,
        });
        if (setErr) {
          if (active) setError(setErr.message);
          return;
        }
        goHome();
        return;
      }

      // PKCE / detectSessionInUrl may still be resolving.
      const { data } = await supabase.auth.getSession();
      if (data.session) {
        goHome();
        return;
      }
    }

    void run();

    const { data: sub } = supabase.auth.onAuthStateChange((_event, session) => {
      if (session) goHome();
    });

    const timeout = setTimeout(() => {
      if (!active || finished) return;
      void supabase.auth.getSession().then(({ data }) => {
        if (data.session) goHome();
        else if (active) {
          setError('Missing session tokens. Sign in again from Voter Analytics.');
        }
      });
    }, 8000);

    return () => {
      active = false;
      clearTimeout(timeout);
      sub.subscription.unsubscribe();
    };
  }, [navigate]);

  if (error) {
    return (
      <div className="flex min-h-screen items-center justify-center px-4">
        <div className="w-full max-w-sm space-y-4">
          <Alert variant="error">{error}</Alert>
          <button
            type="button"
            className="btn-primary w-full"
            onClick={() => navigate('/', { replace: true })}
          >
            Back
          </button>
        </div>
      </div>
    );
  }

  return <Spinner label="Signing you in…" />;
}

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import type { Session } from '@supabase/supabase-js';
import { PORTAL_URL, supabase } from '../lib/supabase';
import type { Profile } from '../lib/types';

interface AuthContextValue {
  session: Session | null;
  profile: Profile | null;
  loading: boolean;
  profileChecked: boolean;
  signOut: () => Promise<void>;
  refreshProfile: () => Promise<void>;
  /** Redirect to the campaign portal login with return handoff. */
  goToPortalLogin: () => void;
  /** Same campaign Google auth, returns to this app (no portal deploy needed). */
  signInWithGoogle: () => Promise<{ error: string | null }>;
  signInWithPassword: (
    email: string,
    password: string,
  ) => Promise<{ error: string | null }>;
}

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

async function fetchProfile(userId: string): Promise<Profile | null> {
  const { data } = await supabase
    .from('profiles')
    .select('id, email, full_name, role')
    .eq('id', userId)
    .maybeSingle();
  return (data as Profile) ?? null;
}

async function fetchProfileWithRetry(userId: string): Promise<Profile | null> {
  for (let attempt = 0; attempt < 4; attempt++) {
    const profile = await fetchProfile(userId);
    if (profile) return profile;
    if (attempt < 3) await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
  }
  return null;
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [loading, setLoading] = useState(true);
  const [profileChecked, setProfileChecked] = useState(false);
  const profileRef = useRef<Profile | null>(null);
  profileRef.current = profile;

  const loadProfile = useCallback(
    async (
      userId: string,
      opts: { retry?: boolean; silent?: boolean } = {},
    ) => {
      const alreadyHave =
        profileRef.current?.id === userId && !!profileRef.current?.role;
      const silent = opts.silent ?? alreadyHave;
      if (!silent) setProfileChecked(false);
      const data = opts.retry
        ? await fetchProfileWithRetry(userId)
        : await fetchProfile(userId);
      setProfile(data);
      setProfileChecked(true);
    },
    [],
  );

  useEffect(() => {
    let active = true;

    supabase.auth.getSession().then(async ({ data }) => {
      if (!active) return;
      setSession(data.session);
      if (data.session?.user) {
        await loadProfile(data.session.user.id, { retry: true });
      } else {
        setProfile(null);
        setProfileChecked(true);
      }
      if (active) setLoading(false);
    });

    const { data: sub } = supabase.auth.onAuthStateChange(async (event, newSession) => {
      if (event === 'TOKEN_REFRESHED') {
        setSession(newSession);
        return;
      }
      setSession(newSession);
      if (newSession?.user) {
        await loadProfile(newSession.user.id, {
          retry: event === 'SIGNED_IN' || event === 'INITIAL_SESSION',
          silent: event === 'USER_UPDATED',
        });
      } else {
        setProfile(null);
        setProfileChecked(true);
      }
    });

    return () => {
      active = false;
      sub.subscription.unsubscribe();
    };
  }, [loadProfile]);

  const signOut = useCallback(async () => {
    await supabase.auth.signOut();
    setProfile(null);
    setProfileChecked(true);
  }, []);

  const refreshProfile = useCallback(async () => {
    if (session?.user) {
      await loadProfile(session.user.id, { retry: true, silent: true });
    }
  }, [session, loadProfile]);

  const goToPortalLogin = useCallback(() => {
    const returnTo = `${window.location.origin}/auth/bridge`;
    const url = new URL(`${PORTAL_URL}/login`);
    url.searchParams.set('return_to', returnTo);
    window.location.href = url.toString();
  }, []);

  const signInWithGoogle = useCallback(async () => {
    const { error } = await supabase.auth.signInWithOAuth({
      provider: 'google',
      options: {
        redirectTo: `${window.location.origin}/auth/bridge`,
      },
    });
    return { error: error?.message ?? null };
  }, []);

  const signInWithPassword = useCallback(async (email: string, password: string) => {
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    return { error: error?.message ?? null };
  }, []);

  const value = useMemo<AuthContextValue>(
    () => ({
      session,
      profile,
      loading,
      profileChecked,
      signOut,
      refreshProfile,
      goToPortalLogin,
      signInWithGoogle,
      signInWithPassword,
    }),
    [
      session,
      profile,
      loading,
      profileChecked,
      signOut,
      refreshProfile,
      goToPortalLogin,
      signInWithGoogle,
      signInWithPassword,
    ],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

// eslint-disable-next-line react-refresh/only-export-components
export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}

import { createContext, useContext, useEffect, useState } from 'react';
import { api } from './api';

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null); // { id, email } | null
  const [loading, setLoading] = useState(true);

  // On mount, if a token is already saved, verify it's still good and restore the session.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!api.getToken()) {
        setLoading(false);
        return;
      }
      try {
        const me = await api.me();
        if (!cancelled) setUser(me);
      } catch (e) {
        api.clearToken(); // expired/invalid token - fall back to the login screen
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // The server sends the "you've signed up" email itself (best-effort) as part of /api/signup,
  // and signup logs the person straight in - no separate confirmation-click step required.
  async function signUp(email, password) {
    try {
      const me = await api.signup(email, password);
      setUser(me);
      return { error: null };
    } catch (e) {
      return { error: { message: e.message } };
    }
  }

  async function signIn(email, password) {
    try {
      const me = await api.login(email, password);
      setUser(me);
      return { error: null };
    } catch (e) {
      return { error: { message: e.message } };
    }
  }

  function signOut() {
    api.clearToken();
    setUser(null);
  }

  const value = {
    // Kept as `session.user` (rather than just `user`) so the rest of the app - which was built
    // expecting a Supabase-shaped session - didn't need to change.
    session: user ? { user } : null,
    user,
    loading,
    signUp,
    signIn,
    signOut,
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside AuthProvider');
  return ctx;
}

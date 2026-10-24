import { useState } from 'react';
import { useAuth } from './AuthContext';

export default function AuthScreen() {
  const { signUp, signIn } = useAuth();
  const [mode, setMode] = useState('login'); // 'login' | 'signup'
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  function switchMode(next) {
    setMode(next);
    setError('');
  }

  async function handleSubmit(e) {
    e.preventDefault();
    setError('');

    if (!email.trim() || !password) {
      setError('Enter an email and password.');
      return;
    }
    if (mode === 'signup') {
      if (password.length < 6) {
        setError('Password must be at least 6 characters.');
        return;
      }
      if (password !== confirmPassword) {
        setError('Passwords do not match.');
        return;
      }
    }

    setLoading(true);
    const { error } = mode === 'signup' ? await signUp(email.trim(), password) : await signIn(email.trim(), password);
    setLoading(false);
    if (error) setError(error.message);
    // On success, AuthContext's `user` is already set and App swaps this screen out automatically.
  }

  return (
    <div style={{ minHeight: '100svh', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
      <div style={{ width: '100%', maxWidth: 380, padding: 28, border: '1px solid #223247', borderRadius: 12, background: '#111a26', boxShadow: 'rgba(0, 0, 0, 0.4) 0 10px 15px -3px, rgba(0, 0, 0, 0.25) 0 4px 6px -2px' }}>
        <h2 style={{ marginTop: 0, textAlign: 'center' }}>Swarm</h2>
        <p style={{ textAlign: 'center', color: '#8296ad', fontSize: 13, marginBottom: 20 }}>
          {mode === 'signup' ? 'Create an account to start farming.' : 'Log in to continue farming.'}
        </p>

        <form onSubmit={handleSubmit}>
          <div style={{ marginBottom: 12 }}>
            <label style={{ display: 'block', fontSize: 12, color: '#8296ad', marginBottom: 4 }}>Email</label>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              style={{ width: '100%', padding: 8, borderRadius: 6 }}
              autoComplete="email"
            />
          </div>
          <div style={{ marginBottom: 12 }}>
            <label style={{ display: 'block', fontSize: 12, color: '#8296ad', marginBottom: 4 }}>Password</label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              style={{ width: '100%', padding: 8, borderRadius: 6 }}
              autoComplete={mode === 'signup' ? 'new-password' : 'current-password'}
            />
          </div>
          {mode === 'signup' && (
            <div style={{ marginBottom: 12 }}>
              <label style={{ display: 'block', fontSize: 12, color: '#8296ad', marginBottom: 4 }}>Confirm Password</label>
              <input
                type="password"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                style={{ width: '100%', padding: 8, borderRadius: 6 }}
                autoComplete="new-password"
              />
            </div>
          )}

          {error && <div style={{ color: '#ff5d6c', fontSize: 13, marginBottom: 12 }}>{error}</div>}

          <button
            type="submit"
            disabled={loading}
            style={{ width: '100%', padding: 10, background: '#5ec8ff', color: '#1a1a1a', fontWeight: 'bold', border: 'none', borderRadius: 6, cursor: 'pointer' }}
          >
            {loading ? 'Please wait...' : mode === 'signup' ? 'Sign Up' : 'Log In'}
          </button>
        </form>

        <div style={{ textAlign: 'center', marginTop: 16, fontSize: 13 }}>
          {mode === 'signup' ? (
            <span>
              Already have an account?{' '}
              <a href="#" onClick={(e) => { e.preventDefault(); switchMode('login'); }} style={{ color: '#5ec8ff' }}>
                Log in
              </a>
            </span>
          ) : (
            <span>
              New here?{' '}
              <a href="#" onClick={(e) => { e.preventDefault(); switchMode('signup'); }} style={{ color: '#5ec8ff' }}>
                Sign up
              </a>
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

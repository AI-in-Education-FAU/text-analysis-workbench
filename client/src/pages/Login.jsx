import { useState } from 'react';
import { supabase } from '../utils/supabase';

/** FR-1: researchers sign in with Supabase Auth before they can query data or run analyses. */
export default function Login() {
  const [mode, setMode] = useState('signin');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [message, setMessage] = useState(null);

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      if (mode === 'signin') {
        const { error: err } = await supabase.auth.signInWithPassword({ email, password });
        if (err) throw err;
      } else if (mode === 'signup') {
        const { data, error: err } = await supabase.auth.signUp({ email, password });
        if (err) throw err;
        if (!data.session) setMessage('Account created. Check your email to confirm it, then sign in.');
      } else {
        const { error: err } = await supabase.auth.resetPasswordForEmail(email, { redirectTo: window.location.origin });
        if (err) throw err;
        setMessage('If that account exists, a password reset email has been sent.');
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="login-wrap">
      <form className="panel login" onSubmit={submit}>
        <div className="brand" style={{ color: 'inherit' }}>Text Analysis <span>Workbench</span></div>
        <h2 style={{ margin: '0.5rem 0 1rem' }}>{mode === 'signin' ? 'Sign in' : mode === 'signup' ? 'Create account' : 'Reset password'}</h2>
        <label className="field">Email<input type="email" required autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} /></label>
        {mode !== 'reset' && (
          <label className="field">Password
            <input type="password" required minLength={6} autoComplete={mode === 'signin' ? 'current-password' : 'new-password'} value={password} onChange={(e) => setPassword(e.target.value)} />
          </label>
        )}
        {error && <div className="alert error">{error}</div>}
        {message && <div className="alert info">{message}</div>}
        <button className="primary" type="submit" disabled={busy} style={{ width: '100%' }}>
          {busy ? 'Please wait…' : mode === 'signin' ? 'Sign in' : mode === 'signup' ? 'Create account' : 'Send reset email'}
        </button>
        <div className="row small" style={{ marginTop: '0.75rem', justifyContent: 'space-between' }}>
          {mode !== 'signin' && <button type="button" className="link" onClick={() => setMode('signin')}>Back to sign in</button>}
          {mode === 'signin' && <button type="button" className="link" onClick={() => setMode('signup')}>Create an account</button>}
          {mode === 'signin' && <button type="button" className="link" onClick={() => setMode('reset')}>Forgot password?</button>}
        </div>
      </form>
    </div>
  );
}

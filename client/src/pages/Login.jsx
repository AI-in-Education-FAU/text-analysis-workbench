import { useState } from 'react';
import { useApp } from '../AppContext';
import { supabase } from '../utils/supabase';

function friendlyError(err) {
  const code = err?.code || err?.error_code;
  if (code === 'over_email_send_rate_limit' || /rate limit/i.test(err?.message || '')) {
    return 'Too many emails were sent recently. Please wait a while and try again, or ask the administrator to reset your password.';
  }
  if (code === 'invalid_credentials') return 'Incorrect email or password. Use "Forgot password?" if you need to reset it.';
  if (code === 'user_already_exists') return 'An account with this email already exists. Sign in instead.';
  if (code === 'email_not_confirmed') return 'This email address has not been confirmed yet. Check your inbox for the confirmation link.';
  return err?.message || 'Something went wrong.';
}

/** FR-1: researchers sign in with Supabase Auth before they can query data or run analyses. */
export default function Login() {
  const { recovering, setRecovering } = useApp();
  const [mode, setMode] = useState('signin');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [message, setMessage] = useState(null);
  const current = recovering ? 'update' : mode;

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      if (current === 'update') {
        const { error: err } = await supabase.auth.updateUser({ password });
        if (err) throw err;
        setRecovering(false);
      } else if (current === 'signin') {
        const { error: err } = await supabase.auth.signInWithPassword({ email, password });
        if (err) throw err;
      } else if (current === 'signup') {
        const { data, error: err } = await supabase.auth.signUp({ email, password, options: { emailRedirectTo: window.location.origin } });
        if (err) throw err;
        if (!data.session) setMessage('Account created. Check your email to confirm it, then sign in.');
      } else {
        const { error: err } = await supabase.auth.resetPasswordForEmail(email, { redirectTo: window.location.origin });
        if (err) throw err;
        setMessage('If that account exists, a password reset email has been sent.');
      }
    } catch (err) {
      setError(friendlyError(err));
    } finally {
      setBusy(false);
    }
  };

  const titles = { signin: 'Sign in', signup: 'Create account', reset: 'Reset password', update: 'Choose a new password' };
  const actions = { signin: 'Sign in', signup: 'Create account', reset: 'Send reset email', update: 'Save new password' };

  return (
    <div className="login-wrap">
      <form className="panel login" onSubmit={submit}>
        <div className="brand" style={{ color: 'inherit' }}>Text Analysis <span>Workbench</span></div>
        <h2 style={{ margin: '0.5rem 0 1rem' }}>{titles[current]}</h2>
        {current !== 'update' && (
          <label className="field">Email<input type="email" required autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} /></label>
        )}
        {current !== 'reset' && (
          <label className="field">Password
            <input type="password" required minLength={6} autoComplete={current === 'signin' ? 'current-password' : 'new-password'} value={password} onChange={(e) => setPassword(e.target.value)} />
          </label>
        )}
        {error && <div className="alert error">{error}</div>}
        {message && <div className="alert info">{message}</div>}
        <button className="primary" type="submit" disabled={busy} style={{ width: '100%' }}>
          {busy ? 'Please wait…' : actions[current]}
        </button>
        {current === 'update' && (
          <div className="row small" style={{ marginTop: '0.75rem', justifyContent: 'flex-end' }}>
            <button type="button" className="link" onClick={() => setRecovering(false)}>Cancel</button>
          </div>
        )}
        {current !== 'update' && (
          <div className="row small" style={{ marginTop: '0.75rem', justifyContent: 'space-between' }}>
            {mode !== 'signin' && <button type="button" className="link" onClick={() => setMode('signin')}>Back to sign in</button>}
            {mode === 'signin' && <button type="button" className="link" onClick={() => setMode('signup')}>Create an account</button>}
            {mode === 'signin' && <button type="button" className="link" onClick={() => setMode('reset')}>Forgot password?</button>}
          </div>
        )}
      </form>
    </div>
  );
}

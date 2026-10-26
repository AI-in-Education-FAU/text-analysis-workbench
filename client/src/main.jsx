import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import App from './App.jsx';
import { supabaseConfigured } from './utils/supabase.js';
import './styles.css';

function MissingConfig() {
  return (
    <div className="login-wrap">
      <div className="panel login">
        <h2 style={{ marginTop: 0 }}>Site not configured</h2>
        <p>
          This build is missing <code>VITE_SUPABASE_URL</code> and/or <code>VITE_SUPABASE_PUBLISHABLE_KEY</code>.
          Set them in <code>client/.env</code> (local) or in your host&apos;s environment variables, then rebuild.
        </p>
      </div>
    </div>
  );
}

createRoot(document.getElementById('root')).render(
  <StrictMode>
    {supabaseConfigured ? (
      <BrowserRouter>
        <App />
      </BrowserRouter>
    ) : <MissingConfig />}
  </StrictMode>,
);

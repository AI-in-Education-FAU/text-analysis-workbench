import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { api } from './utils/api';
import { supabase } from './utils/supabase';

const AppContext = createContext(null);
const STORAGE_KEY = 'nlp-workbench-selection';
const PROJECT_KEY = 'nlp-workbench-project';

function loadSelection() {
  try {
    const s = JSON.parse(sessionStorage.getItem(STORAGE_KEY));
    if (s && Array.isArray(s.ids)) return s;
  } catch { /* ignore corrupt storage */ }
  return { target: 'articles', ids: [], description: '' };
}

export function AppProvider({ children }) {
  const [selection, setSelectionState] = useState(loadSelection);
  const [serverConfig, setServerConfig] = useState(null);
  const [serverError, setServerError] = useState(null);
  const [session, setSession] = useState(undefined);
  const [projects, setProjects] = useState([]);
  const [projectId, setProjectIdState] = useState(() => localStorage.getItem(PROJECT_KEY) || '');

  const refreshConfig = useCallback(() => {
    api.config().then((c) => { setServerConfig(c); setServerError(null); }).catch((e) => setServerError(e.message));
  }, []);

  useEffect(refreshConfig, [refreshConfig]);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setSession(data.session ?? null));
    const { data: sub } = supabase.auth.onAuthStateChange((_event, s) => setSession(s ?? null));
    return () => sub.subscription.unsubscribe();
  }, []);

  const refreshProjects = useCallback(async () => {
    if (!session) { setProjects([]); return; }
    try {
      setProjects(await api.projects());
    } catch (e) {
      setServerError(e.message);
    }
  }, [session]);

  useEffect(() => { refreshProjects(); }, [refreshProjects]);

  const setSelection = useCallback((next) => {
    setSelectionState(next);
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  }, []);

  const setProjectId = useCallback((id) => {
    setProjectIdState(id ? String(id) : '');
    if (id) localStorage.setItem(PROJECT_KEY, String(id));
    else localStorage.removeItem(PROJECT_KEY);
  }, []);

  const activeProject = projects.find((p) => String(p.id) === String(projectId)) || null;

  const signOut = useCallback(async () => {
    await supabase.auth.signOut();
    setSelection({ target: 'articles', ids: [], description: '' });
  }, [setSelection]);

  return (
    <AppContext.Provider
      value={{
        selection, setSelection, serverConfig, serverError, refreshConfig,
        session, user: session?.user || null, signOut,
        projects, refreshProjects, projectId: activeProject ? projectId : '', setProjectId, activeProject,
      }}
    >
      {children}
    </AppContext.Provider>
  );
}

export const useApp = () => useContext(AppContext);

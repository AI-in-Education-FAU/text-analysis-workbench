import { NavLink, Route, Routes } from 'react-router-dom';
import { AppProvider, useApp } from './AppContext.jsx';
import Dashboard from './pages/Dashboard.jsx';
import Explore from './pages/Explore.jsx';
import Analyze from './pages/Analyze.jsx';
import CorpusTools from './pages/CorpusTools.jsx';
import Runs from './pages/Runs.jsx';
import RunDetail from './pages/RunDetail.jsx';
import Methods from './pages/Methods.jsx';
import Login from './pages/Login.jsx';
import Projects from './pages/Projects.jsx';
import Review from './pages/Review.jsx';
import ReferenceLabels from './pages/ReferenceLabels.jsx';

function SelectionBadge() {
  const { selection } = useApp();
  if (!selection.ids.length) return <div className="sel-badge muted">Nothing selected</div>;
  return (
    <div className="sel-badge">
      <strong>{selection.ids.length}</strong> {selection.target} selected
      {selection.description && <div className="muted small">{selection.description}</div>}
    </div>
  );
}

function ProjectPicker() {
  const { projects, projectId, setProjectId } = useApp();
  return (
    <div className="project-picker">
      <label className="small">Active project
        <select value={projectId} onChange={(e) => setProjectId(e.target.value)}>
          <option value="">— none —</option>
          {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
      </label>
    </div>
  );
}

function Layout() {
  const { serverError, user, signOut, setRecovering } = useApp();
  const links = [
    ['/', 'Dashboard'],
    ['/projects', 'Projects'],
    ['/explore', '1 · Explore data'],
    ['/analyze', '2 · Analyze'],
    ['/review', '3 · Review & validate'],
    ['/reference', 'Reference labels'],
    ['/corpus', 'Corpus tools'],
    ['/runs', 'Saved runs'],
    ['/methods', 'Method guide'],
  ];
  return (
    <div className="layout">
      <aside className="sidebar">
        <div className="brand">Text Analysis<br /><span>Workbench</span></div>
        <ProjectPicker />
        <nav>
          {links.map(([to, label]) => (
            <NavLink key={to} to={to} end={to === '/'} className={({ isActive }) => (isActive ? 'active' : '')}>
              {label}
            </NavLink>
          ))}
        </nav>
        <SelectionBadge />
        <div className="user-box">
          <div className="small" title={user?.email}>{user?.email}</div>
          <button className="link small" onClick={() => setRecovering(true)}>Change password</button>
          <button className="link small" onClick={signOut}>Sign out</button>
        </div>
      </aside>
      <main className="content">
        {serverError && <div className="alert error">Analysis server: {serverError}</div>}
        <Routes>
          <Route path="/" element={<Dashboard />} />
          <Route path="/projects" element={<Projects />} />
          <Route path="/explore" element={<Explore />} />
          <Route path="/analyze" element={<Analyze />} />
          <Route path="/review" element={<Review />} />
          <Route path="/reference" element={<ReferenceLabels />} />
          <Route path="/corpus" element={<CorpusTools />} />
          <Route path="/runs" element={<Runs />} />
          <Route path="/runs/:id" element={<RunDetail />} />
          <Route path="/methods" element={<Methods />} />
          <Route path="*" element={<p>Page not found.</p>} />
        </Routes>
      </main>
    </div>
  );
}

function Gate() {
  const { session, recovering } = useApp();
  if (session === undefined) return <p className="muted" style={{ padding: '2rem' }}>Loading…</p>;
  if (!session || recovering) return <Login />;
  return <Layout />;
}

export default function App() {
  return (
    <AppProvider>
      <Gate />
    </AppProvider>
  );
}

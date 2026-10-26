import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useApp } from '../AppContext.jsx';
import ItemModal from '../components/ItemModal.jsx';
import { api } from '../utils/api';
import { downloadFile, num, toCSV } from '../utils/metrics';

export default function CorpusTools() {
  const { selection, serverConfig } = useApp();
  const [tab, setTab] = useState('keywords');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [kw, setKw] = useState(null);
  const [term, setTerm] = useState('');
  const [kwic, setKwic] = useState(null);
  const [focus, setFocus] = useState('');
  const [summary, setSummary] = useState(null);
  const [open, setOpen] = useState(null);

  const base = { target: selection.target, ids: selection.ids };
  const runTool = (fn) => async (e) => {
    e?.preventDefault();
    setBusy(true);
    setError(null);
    try { await fn(); } catch (err) { setError(err.message); } finally { setBusy(false); }
  };

  if (!selection.ids.length) {
    return <><h1>Corpus tools</h1><div className="alert warn">No items selected. <Link to="/explore">Go to Explore</Link> first.</div></>;
  }

  return (
    <>
      <div className="page-header">
        <div>
          <h1>Corpus tools</h1>
          <p className="muted">Transparent, exploratory views of the {selection.ids.length} selected {selection.target}. Use them to sanity-check model outputs.</p>
        </div>
      </div>
      <div className="tabs">
        {[['keywords', 'Keywords & keyphrases'], ['kwic', 'Concordance (KWIC)'], ['summary', 'AI overview']].map(([id, label]) => (
          <button key={id} className={tab === id ? 'active' : ''} onClick={() => setTab(id)}>{label}</button>
        ))}
      </div>
      {error && <div className="alert error">{error}</div>}

      {tab === 'keywords' && (
        <>
          <div className="row" style={{ marginBottom: '1rem' }}>
            <button className="primary" disabled={busy} onClick={runTool(async () => setKw(await api.keywords(base)))}>{busy ? 'Computing…' : 'Compute keywords'}</button>
            {kw && (
              <button onClick={() => downloadFile('keyphrases.csv', toCSV(['id', 'title', 'keyphrases'], kw.perDocument.map((d) => [d.id, d.title, d.keyphrases])), 'text/csv')}>
                Export per-document keyphrases
              </button>
            )}
          </div>
          {kw && (
            <>
              <div className="grid cols-3">
                <div className="stat"><div className="value">{kw.documents}</div><div className="label">Documents</div></div>
                <div className="stat"><div className="value">{kw.totalTokens.toLocaleString()}</div><div className="label">Content tokens (stopwords removed)</div></div>
                <div className="stat"><div className="value">{kw.uniqueTerms.toLocaleString()}</div><div className="label">Unique terms</div></div>
              </div>
              <div className="grid cols-3" style={{ marginTop: '1rem' }}>
                <div className="panel">
                  <h3 style={{ marginTop: 0 }}>Most frequent terms</h3>
                  <table>
                    <thead><tr><th>Term</th><th className="num">Count</th><th className="num">/1k</th><th className="num">Docs</th></tr></thead>
                    <tbody>{kw.topTerms.map((t) => (
                      <tr key={t.term}><td><button className="link" onClick={() => { setTerm(t.term); setTab('kwic'); }}>{t.term}</button></td><td className="num">{t.count}</td><td className="num">{num(t.perThousand, 1)}</td><td className="num">{t.docs}</td></tr>
                    ))}</tbody>
                  </table>
                </div>
                <div className="panel">
                  <h3 style={{ marginTop: 0 }}>Distinctive (TF-IDF)</h3>
                  <table>
                    <thead><tr><th>Term</th><th className="num">Weight</th><th className="num">Docs</th></tr></thead>
                    <tbody>{kw.distinctive.map((t) => <tr key={t.term}><td>{t.term}</td><td className="num">{num(t.weight, 3)}</td><td className="num">{t.docs}</td></tr>)}</tbody>
                  </table>
                </div>
                <div className="panel">
                  <h3 style={{ marginTop: 0 }}>Top bigrams</h3>
                  <table>
                    <thead><tr><th>Phrase</th><th className="num">Count</th></tr></thead>
                    <tbody>{kw.topBigrams.map((t) => <tr key={t.term}><td>{t.term}</td><td className="num">{t.count}</td></tr>)}</tbody>
                  </table>
                </div>
              </div>
              <p className="muted small">Frequency is not importance; corpus composition and document length strongly affect these lists.</p>
            </>
          )}
        </>
      )}

      {tab === 'kwic' && (
        <>
          <form className="row" style={{ marginBottom: '1rem' }} onSubmit={runTool(async () => setKwic(await api.concordance({ ...base, term })))}>
            <input type="search" value={term} onChange={(e) => setTerm(e.target.value)} placeholder="word or phrase" style={{ width: 280 }} />
            <button className="primary" type="submit" disabled={busy || !term.trim()}>{busy ? 'Searching…' : 'Search'}</button>
            {kwic && <span className="muted">“{kwic.term}” in {kwic.docsWithHits} of {kwic.documents} documents · {kwic.lines.length} line(s) shown</span>}
          </form>
          {kwic && (
            <div className="table-wrap">
              <table className="kwic">
                <tbody>
                  {kwic.lines.map((l, i) => (
                    <tr key={i}>
                      <td><button className="link" onClick={() => setOpen(l.id)}>#{l.id}</button></td>
                      <td className="left"><bdi>{l.left}</bdi></td>
                      <td className="match">{l.match}</td>
                      <td className="right">{l.right}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}

      {tab === 'summary' && (
        <>
          {!serverConfig?.openai && <div className="alert warn">Requires OPENAI_API_KEY on the server.</div>}
          <form className="panel" onSubmit={runTool(async () => setSummary(await api.summarize({ ...base, focus })))}>
            <label className="field">Focus question (optional)
              <input type="text" value={focus} onChange={(e) => setFocus(e.target.value)} placeholder="e.g. What reasons do commenters give for opposing the policy?" />
            </label>
            <div className="row" style={{ marginTop: '0.75rem' }}>
              <button className="primary" type="submit" disabled={busy || !serverConfig?.openai}>{busy ? 'Summarizing…' : 'Generate grounded overview'}</button>
              <span className="muted small">Uses a spread sample of up to 60 items. Every theme cites item ids and a quote that is checked against the source.</span>
            </div>
          </form>
          {summary && (
            <div className="panel">
              <p className="muted small">Model {summary.model} · sampled {summary.sampled} of {summary.selected} items</p>
              <p>{summary.overview}</p>
              {summary.themes.map((t, i) => (
                <div key={i} className="comment">
                  <strong>{t.theme}</strong>
                  <div>{t.summary}</div>
                  {t.quote && (
                    <div className="evidence small">
                      “{t.quote}” {t.quoteId && <button className="link" onClick={() => setOpen(t.quoteId)}>#{t.quoteId}</button>}{' '}
                      {t.quoteVerified ? <span className="ok-text">✓ verified</span> : <span className="bad-text">✗ quote not found verbatim</span>}
                    </div>
                  )}
                  <div className="muted small">Cited items: {t.ids.map((id) => <button key={id} className="link" style={{ marginRight: 6 }} onClick={() => setOpen(id)}>#{id}</button>)}</div>
                </div>
              ))}
              {summary.caveats && <div className="alert warn" style={{ marginTop: '1rem' }}>Caveats: {summary.caveats}</div>}
              <p className="muted small">An LLM summary is a reading aid, not a prevalence estimate. Use the Analyze page for counts.</p>
            </div>
          )}
        </>
      )}

      {open !== null && <ItemModal target={selection.target} id={open} onClose={() => setOpen(null)} />}
    </>
  );
}

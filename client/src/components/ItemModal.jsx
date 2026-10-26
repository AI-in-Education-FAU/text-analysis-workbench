import { useEffect, useState } from 'react';
import { getArticle, getComment } from '../utils/data';
import { pseudonym } from '../utils/metrics';

/** Side panel showing the full text of an article (with its comments) or a single comment. */
export default function ItemModal({ target, id, onClose }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    setData(null);
    setError(null);
    const load = target === 'articles' ? getArticle(id) : getComment(id).then((comment) => ({ comment }));
    load.then(setData).catch((e) => setError(e.message));
  }, [target, id]);

  useEffect(() => {
    const onKey = (e) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="row"><span className="spacer" /><button onClick={onClose}>Close ✕</button></div>
        {error && <div className="alert error">{error}</div>}
        {!data && !error && <p className="muted">Loading…</p>}
        {data?.article && <ArticleView article={data.article} comments={data.comments} />}
        {data?.comment && <CommentView comment={data.comment} />}
      </div>
    </div>
  );
}

function ArticleView({ article, comments }) {
  const [reveal, setReveal] = useState(false);
  const author = article.author ? (reveal ? article.author : pseudonym(article.author)) : null;
  const meta = [article.source, article.source_type, author, article.published_date, article.keyword && `keyword: ${article.keyword}`].filter(Boolean);
  return (
    <>
      <h2>{article.title || '(untitled)'}</h2>
      <p className="muted">
        #{article.id} · {meta.join(' · ')}
        {article.author && <> · <button className="link small" onClick={() => setReveal(!reveal)}>{reveal ? 'hide author' : 'reveal original author'}</button></>}
      </p>
      {article.url && <p><a href={article.url} target="_blank" rel="noreferrer">Open original ↗</a></p>}
      {!article.is_relevant && <div className="alert warn">Marked as not relevant.</div>}
      <div className="fulltext">{article.clean_content || article.content || <em className="muted">No content</em>}</div>
      <h3>Comments ({comments.length})</h3>
      {comments.map((c) => (
        <div key={c.id} className={`comment ${c.parent_comment_id ? 'reply' : ''}`}>
          <div className="muted small">#{c.id} {c.published_date || ''} {c.parent_comment_id ? `↳ reply to #${c.parent_comment_id}` : ''}</div>
          <div>{c.text}</div>
        </div>
      ))}
    </>
  );
}

function CommentView({ comment }) {
  return (
    <>
      <h2>Comment #{comment.id}</h2>
      <p className="muted">{comment.published_date || ''} {comment.parent_comment_id ? `· reply to #${comment.parent_comment_id}` : ''}</p>
      <div className="fulltext panel">{comment.text}</div>
      {comment.articles && (
        <p>
          On article: <strong>{comment.articles.title}</strong> ({comment.articles.source})
          {comment.articles.url && <> · <a href={comment.articles.url} target="_blank" rel="noreferrer">original ↗</a></>}
        </p>
      )}
    </>
  );
}

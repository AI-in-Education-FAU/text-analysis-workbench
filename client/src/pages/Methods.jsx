import { Link } from 'react-router-dom';
import { useApp } from '../AppContext.jsx';

const GUIDE = [
  {
    task: 'Sentiment analysis',
    when: 'You want the evaluative tone (positive / neutral / negative) of each text.',
    caution: 'Bad news ≠ negative author sentiment. Mixed opinions, sarcasm and quotations are common failure cases. Lexicons ignore context; SST-2 has no neutral class.',
    metrics: 'Macro-F1, per-class precision/recall, confusion matrix (neutral errors).',
  },
  {
    task: 'Stance detection',
    when: 'You want support/opposition toward an explicit target or proposition (e.g. “the city should ban private cars downtown”).',
    caution: 'Stance is not sentiment (“I hate traffic; this ban is overdue” favours the ban). Decide whether you code the author’s stance or quoted speakers. No off-the-shelf stance model is reliable for every target — validate per target.',
    metrics: 'Macro-F1 over favor/against/neutral; also report mean F1 of favor & against for SemEval-2016 comparability.',
  },
  {
    task: 'Conversational stance (comments)',
    when: 'You want to know whether a comment supports, opposes, questions or is neutral toward its parent comment or the article it replies to.',
    caution: 'Only comments with a parent comment or article are eligible; the others are reported as ?not applicable?, never forced into a label. Agreement with a person is not agreement with a policy.',
    metrics: 'Macro-F1 over support/oppose/question/neutral on a reference sample of replies; report ineligible counts separately.',
  },
  {
    task: 'Stakeholder classification',
    when: 'You need to know who is speaking or being represented (government, industry, advocacy, academic, media, public, other).',
    caution: 'Byline, outlet and quoted speakers can disagree; decide which one the codebook codes. Rules based on the author or source field are a transparent baseline only.',
    metrics: 'Macro-F1 and per-class recall (small classes such as academic are easily missed).',
  },
  {
    task: 'Topic modeling',
    when: 'Themes are unknown and you want to explore the corpus (LDA/NMF/LLM discovery), or you have known categories (zero-shot / LLM with labels).',
    caution: 'Topics are analyst-interpreted. Results depend on preprocessing, k and seed — rerun with different seeds and k. Short comments give little co-occurrence evidence. Better topic names ≠ better clustering.',
    metrics: 'Read representative documents; stability across seeds; human review. Held-out likelihood does not measure interpretability.',
  },
  {
    task: 'Emotion detection',
    when: 'Polarity is too coarse and you need to distinguish anger from fear or sadness.',
    caution: 'Expressed emotion is not a measure of internal mental state. Emotions overlap; fine-grained labels have low human agreement.',
    metrics: 'Macro-F1, per-label precision/recall; inspect rare classes.',
  },
  {
    task: 'Custom codebook classification',
    when: 'You have a predefined taxonomy (frames, issues, relevance, actor types) and want it applied consistently.',
    caution: 'Write the codebook before comparing models, include an “other” category, and keep prompt-tuning examples out of your evaluation sample. LLM self-reported confidence is not calibrated.',
    metrics: 'Macro-F1, per-class scores, agreement with a second human coder (κ).',
  },
];

const KINDS = [
  ['Lexicon / rules (baselines)', 'AFINN, VADER, cue-phrase stance, self-identification stakeholder rules, target-sentence sentiment', 'Free, instant, fully transparent and reproducible. Weak on context, domain vocabulary and sarcasm. Marked ?baseline?: every AI method is compared against them in the evaluation table.'],
  ['Statistical', 'LDA, NMF, TF-IDF keywords', 'Free and local. Unsupervised; outputs need human interpretation. Sensitive to settings and seed.'],
  ['Transformer (Hugging Face)', 'RoBERTa, DistilBERT, DistilRoBERTa-emotion, BART-MNLI zero-shot', 'Context-aware. Check each model card’s training domain and labels. Long texts are truncated or chunked. Requires HF token; texts leave your machine.'],
  ['LLM (OpenAI)', 'GPT models via structured JSON prompts', 'Flexible codebooks, handles nuance, gives evidence quotes. Paid, slower, model versions change over time, and outputs may be non-deterministic — record the model and validate.'],
];

export default function Methods() {
  const { serverConfig } = useApp();
  return (
    <>
      <div className="page-header">
        <div>
          <h1>Method guide</h1>
          <p className="muted">Which analysis answers which question, and how to validate it.</p>
        </div>
      </div>

      <div className="table-wrap" style={{ maxHeight: 'none' }}>
        <table>
          <thead><tr><th>Task</th><th>Use when</th><th>Watch out for</th><th>Evaluate with</th></tr></thead>
          <tbody>
            {GUIDE.map((g) => (
              <tr key={g.task}><td><strong>{g.task}</strong></td><td>{g.when}</td><td>{g.caution}</td><td>{g.metrics}</td></tr>
            ))}
          </tbody>
        </table>
      </div>

      <h2>Families of methods</h2>
      <div className="table-wrap" style={{ maxHeight: 'none' }}>
        <table>
          <thead><tr><th>Family</th><th>In this app</th><th>Trade-offs</th></tr></thead>
          <tbody>{KINDS.map(([a, b, c]) => <tr key={a}><td><strong>{a}</strong></td><td>{b}</td><td>{c}</td></tr>)}</tbody>
        </table>
      </div>

      <h2>Quality flags</h2>
      <div className="table-wrap" style={{ maxHeight: 'none' }}>
        <table>
          <thead><tr><th>Flag</th><th>Meaning</th></tr></thead>
          <tbody>
            <tr><td><span className="tag flag low_confidence">low_confidence</span></td><td>Confidence is below the run?s threshold (project setting, default 0.6).</td></tr>
            <tr><td><span className="tag flag conflict">conflict</span></td><td>Methods in the same run gave this item different labels.</td></tr>
            <tr><td><span className="tag flag failed">failed</span></td><td>The method returned an error for this item; use ?Retry failed items?.</td></tr>
          </tbody>
        </table>
      </div>

      <h2>Recommended validation workflow</h2>
      <ol style={{ lineHeight: 1.7 }}>
        <li>Create a <Link to="/projects">project</Link> with your keywords, sources, date range, target and analyses, and write the codebook (unit, target, label boundaries, quotes, mixed cases) before comparing methods.</li>
        <li>Build a <Link to="/reference">reference sample</Link> of 200?300 human-labelled units (import CSV or code in the results view), ideally with two coders to report ?.</li>
        <li>Run the baselines and one or more AI methods on the same items and inspect where they disagree.</li>
        <li>Compare accuracy, macro-F1 and per-class scores against the reference labels; check the confusion matrix for systematic errors.</li>
        <li>Run the chosen method on the full selection; model, prompt, options, version and date are saved with every run.</li>
        <li>In <Link to="/review">Review &amp; validate</Link>, work through flagged and low-confidence items: approve, correct, reject or exclude. Exports include the final label and its source.</li>
        <li>Report predicted prevalence together with its human-audited error, and don?t infer causes from trends alone.</li>
      </ol>

      {serverConfig && (
        <>
          <h2>All available methods</h2>
          {serverConfig.tasks.map((t) => (
            <div key={t.id} className="panel">
              <h3 style={{ marginTop: 0 }}>{t.name}</h3>
              <ul>
                {t.methods.map((m) => (
                  <li key={m.id}>
                    <strong>{m.name}</strong> <span className="tag kind">{m.kind}</span> {m.baseline && <span className="tag baseline">baseline</span>} {!m.available && <span className="tag err">needs {m.provider} key</span>}
                    <div className="muted small">{m.description}</div>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </>
      )}
    </>
  );
}

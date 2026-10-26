import { config } from '../config.js';
import { clamp, mapLimit, tick, truncate } from '../text.js';
import { hfZeroShot } from '../providers/huggingface.js';
import { openaiClassify } from '../providers/openai.js';

/** Author / stakeholder classification (FR-19, FR-20, FR-21). */
export const STAKEHOLDER_LABELS = ['student', 'educator', 'researcher', 'administrator', 'other', 'unknown'];

export const STAKEHOLDER_DEFINITIONS = {
  student: 'the author identifies as a learner (school, college or university student, or a parent writing as/for a student is NOT a student)',
  educator: 'the author teaches: teacher, lecturer, professor, instructor, tutor, teaching assistant',
  researcher: 'the author studies education or AI professionally: academic researcher, scientist, PhD candidate writing about their research',
  administrator: 'the author manages education: principal, dean, superintendent, school board member, district or ministry official, IT/policy staff',
  other: 'the author clearly belongs to another group: parent, journalist, developer, company, politician, general public with an explicit role',
  unknown: 'there is not enough public evidence about who the author is. Use this whenever the role is not explicit.',
};

const RULES = {
  student: [
    /\bi(?:'m| am) (?:a |an )?(?:\w+ )?(?:student|undergrad|freshman|sophomore|junior|senior in (?:high school|college))\b/i,
    /\bas a (?:\w+ )?student\b/i, /\bmy (?:professor|professors|teacher|teachers|classmates|homework|assignments|essay|exam)\b/i,
    /\bi(?:'m| am) (?:in|at) (?:college|university|high school|grade \d+)\b/i,
  ],
  educator: [
    /\bi(?:'m| am) (?:a |an )?(?:\w+ )?(?:teacher|professor|lecturer|instructor|educator|tutor)\b/i,
    /\bas an? (?:\w+ )?(?:teacher|professor|lecturer|instructor|educator|tutor)\b/i, /\bi teach\b/i, /\bmy students\b/i,
    /\bin my (?:class|classroom|course|lectures?)\b/i, /\bi(?:'ve| have) (?:been )?teach(?:ing)?\b/i,
  ],
  researcher: [
    /\bi(?:'m| am) (?:a |an )?(?:\w+ )?(?:researcher|scientist|phd (?:student|candidate)|postdoc)\b/i, /\bas an? (?:\w+ )?researcher\b/i,
    /\bmy (?:research|study|lab|dissertation|paper)\b/i, /\bour (?:study|research|findings|lab)\b/i, /\bi research\b/i,
  ],
  administrator: [
    /\bi(?:'m| am) (?:a |an |the )?(?:\w+ )?(?:principal|dean|superintendent|provost|administrator|school board member|chancellor)\b/i,
    /\bas (?:a |an |the )?(?:\w+ )?(?:principal|dean|superintendent|administrator|board member)\b/i, /\bour (?:district|school board|campus policy)\b/i,
    /\bmy (?:staff|teachers|faculty)\b/i,
  ],
  other: [
    /\bi(?:'m| am) (?:a |an )?(?:parent|mom|dad|mother|father|journalist|reporter|developer|engineer|software engineer)\b/i,
    /\bas a (?:parent|mom|dad|journalist|developer|engineer)\b/i, /\bmy (?:kid|kids|son|daughter|child|children)(?:'s)? (?:school|teacher|homework)\b/i,
  ],
};

const AUTHOR_ROLE = [
  ['educator', /\b(professor|lecturer|teacher|instructor|educator|prof\.)\b/i],
  ['researcher', /\b(researcher|scientist|ph\.?d|research fellow|postdoc)\b/i],
  ['administrator', /\b(principal|dean|superintendent|provost|chancellor|administrator)\b/i],
  ['student', /\bstudent\b/i],
  ['other', /\b(staff writer|reporter|correspondent|editor|journalist|news desk|editorial board)\b/i],
];

/** Self-identification and byline rules; returns unknown when nothing matches (FR-20). Exported for tests. */
export function ruleStakeholder(text, author) {
  const hits = {};
  for (const [label, patterns] of Object.entries(RULES)) {
    const n = patterns.filter((re) => re.test(text || '')).length;
    if (n) hits[label] = n;
  }
  if (author) {
    for (const [label, re] of AUTHOR_ROLE) if (re.test(author)) hits[label] = (hits[label] || 0) + 2;
  }
  const ranked = Object.entries(hits).sort((a, b) => b[1] - a[1]);
  if (!ranked.length) return { label: 'unknown', confidence: 0.6, rationale: 'no self-identification or role in byline' };
  const [[label, n], second] = ranked;
  if (second && second[1] === n) return { label: 'unknown', confidence: 0.4, rationale: `tied cues: ${ranked.map(([l]) => l).join(', ')}` };
  return { label, confidence: clamp(0.55 + 0.1 * n, 0, 0.9), rationale: `${n} role cue(s)${author && AUTHOR_ROLE.some(([l, re]) => l === label && re.test(author)) ? ' incl. byline' : ''}` };
}

const withAuthor = (item) => (item.author ? `Byline: ${item.author}\n${item.text}` : item.text);

export const ruleStakeholderMethod = {
  id: 'self-id-rules',
  name: 'Self-identification rules (baseline)',
  kind: 'lexicon',
  provider: null,
  version: 'self-id-rules-1',
  description:
    'Traditional baseline: regex cues such as “as a teacher”, “my students”, “I’m a PhD student” plus role words in an article byline. Anything else is “unknown”.',
  async run(items, _opts, ctx) {
    const results = [];
    for (let i = 0; i < items.length; i++) {
      results.push(ruleStakeholder(items[i].text, items[i].author));
      if (i % 50 === 49) { ctx.onProgress(i + 1); await tick(); }
    }
    ctx.onProgress(items.length);
    return { results };
  },
};

export const zeroShotStakeholder = {
  id: 'hf-zero-shot',
  name: 'Zero-shot NLI (Hugging Face)',
  kind: 'transformer',
  provider: 'huggingface',
  description: 'NLI model tests “The author of this text is a {student/teacher/…}”. Falls back to “unknown” when the best score is below the minimum (default 0.5).',
  async run(items, opts, ctx) {
    const model = opts.hfZeroShotModel || 'facebook/bart-large-mnli';
    const minScore = Number(opts.stakeholderMinScore ?? 0.5);
    const phrases = {
      student: 'a student',
      educator: 'a teacher or professor',
      researcher: 'a researcher',
      administrator: 'a school administrator',
      other: 'someone else, such as a parent, journalist or member of the public',
    };
    const candidates = Object.values(phrases);
    const labels = Object.keys(phrases);
    let done = 0;
    const results = await mapLimit(items, 4, async (item) => {
      try {
        const ranked = await hfZeroShot(model, truncate(withAuthor(item), 2500), candidates, 'The author of this text is {}.');
        const label = labels[candidates.indexOf(ranked[0].label)];
        const detail = ranked.slice(0, 3).map((r) => `${labels[candidates.indexOf(r.label)]} ${r.score.toFixed(2)}`).join(', ');
        if (ranked[0].score < minScore) return { label: 'unknown', confidence: clamp(1 - ranked[0].score), rationale: `best guess below ${minScore}: ${detail}` };
        return { label, confidence: clamp(ranked[0].score), rationale: detail };
      } catch (e) {
        return { error: e.message };
      } finally {
        ctx.onProgress(++done);
      }
    });
    return { results, summary: { model, minScore } };
  },
};

export const openaiStakeholder = {
  id: 'openai',
  name: 'OpenAI agent (LLM)',
  kind: 'llm',
  provider: 'openai',
  description: 'LLM agent classifies the author from explicit public evidence in the text and byline, quoting the self-identifying phrase. Uses “unknown” when evidence is insufficient.',
  async run(items, opts, ctx) {
    const results = await openaiClassify(items.map((it) => ({ ...it, text: withAuthor(it) })), {
      labels: STAKEHOLDER_LABELS,
      definitions: STAKEHOLDER_DEFINITIONS,
      task: `author / stakeholder classification for research on generative AI in education. Decide who WROTE the text using only explicit evidence (self-identification, byline, signature). Do not infer the role from topic, opinion or writing style; people quoted or mentioned are not the author. If the role is not explicit, answer "unknown".${opts.instructions ? ` Additional instructions: ${truncate(opts.instructions, 500)}` : ''}`,
      model: opts.openaiModel,
      onProgress: ctx.onProgress,
    });
    return { results, summary: { model: opts.openaiModel || config.openaiModel } };
  },
};

export const stakeholderMethods = [ruleStakeholderMethod, zeroShotStakeholder, openaiStakeholder];

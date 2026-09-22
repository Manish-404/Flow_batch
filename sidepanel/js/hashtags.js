// Captions and hashtags derived from your own prompt text.
//
// Nothing here claims to be "trending": no platform exposes trending-hashtag data through its
// API, so these are relevance-derived tags — curated matches for themes the prompt mentions,
// topped up with its own distinctive words.

const STOP = new Set(
  `a an the and or but of to in on at for with from into onto by as is are was were be been being
   this that these those it its their there here you your we our they them he she his her him hers
   convert converted converting turn turns turned make makes made create creates created creating
   generate generated generating render rendered rendering change changed transform transformed
   image images picture pictures photo photos frame frames output outputs version versions
   keep keeps keeping preserve preserved preserving same exact exactly identical must should
   every each all any single both other another such same across listed above below order
   high low very more most much some many few one two three four five
   do does not dont don't can cant could would will shall may might
   use uses used using instead only also per input given where which what when while whatever
   apply applied applying following follow followed rule rules constraint hard soft
   look looks looking like quality style styles styled subject scene scenes shot shots
   left right front back side top bottom center middle
   sec second seconds minute minutes`
    .split(/\s+/)
    .filter(Boolean)
);

// Curated theme matches — good tags that word-frequency alone would not produce.
// `subject: true` marks what is depicted rather than how it is rendered; a caption should
// lead with its subject, so those get a small bias when more themes match than fit.
const THEMES = [
  { re: /\banime\b/i, tags: ['anime', 'animeart', 'animestyle'] },
  { re: /\bmanga\b/i, tags: ['manga'] },
  { re: /cel[\s-]?shad/i, tags: ['celshading'] },
  { re: /\bcinematic\b/i, tags: ['cinematic'] },
  { re: /\billustrat/i, tags: ['illustration', 'digitalart'] },
  { re: /\bcharacter\b/i, tags: ['characterdesign'], subject: true },
  { re: /\bportrait\b/i, tags: ['portrait'], subject: true },
  { re: /\bline\s?art\b/i, tags: ['lineart'] },
  { re: /colou?r\s?grad/i, tags: ['colorgrading'] },
  { re: /\brim\s?light|\blighting\b/i, tags: ['lighting'] },
  { re: /\bnight\b/i, tags: ['nightvibes'], subject: true },
  { re: /\b(city|urban|street|cityscape)\b/i, tags: ['cityscape'], subject: true },
  { re: /\b(scenery|landscape|background)\b/i, tags: ['scenery'], subject: true },
  { re: /\b(motorcycle|motorbike|rider|riding|helmet|biker)\b/i, tags: ['motorcycle', 'riderlife'], subject: true },
  { re: /\b(highway|road|underpass)\b/i, tags: ['ontheroad'], subject: true },
  { re: /\b(animation|animate|animated)\b/i, tags: ['animation'] },
  { re: /\b2d\b/i, tags: ['2dart'] },
];

/**
 * Platforms require creators to disclose realistic AI-generated media. These are offered as a
 * default so a batch does not go out undisclosed — the in-app label on each platform is still
 * the thing that actually satisfies the policy.
 */
export const DISCLOSURE_TAGS = ['aiart', 'aiartwork', 'madewithai'];

export const normaliseTag = (s) =>
  String(s || '')
    .replace(/^#/, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '')
    .slice(0, 40);

export function parseTags(text) {
  return [...new Set(String(text || '').split(/[\s,]+/).map(normaliseTag).filter(Boolean))];
}

export const formatTags = (tags) => tags.map((t) => `#${t}`).join(' ');

/** Tags for one or more prompts: curated theme hits first, then distinctive words. */
export function suggestHashtags(texts, { max = 15 } = {}) {
  const all = (Array.isArray(texts) ? texts : [texts]).join('\n');
  const out = [];
  const add = (t) => {
    const tag = normaliseTag(t);
    if (tag.length > 2 && !out.includes(tag)) out.push(tag);
  };

  // How often a theme is mentioned stands in for how central it is, so when more themes match
  // than fit in `max` the ones the prompt actually dwells on survive the cut.
  THEMES.map((t) => ({ t, hits: (all.match(new RegExp(t.re.source, 'gi')) || []).length }))
    .filter(({ hits }) => hits > 0)
    .sort((a, b) => b.hits + (b.t.subject ? 1 : 0) - (a.hits + (a.t.subject ? 1 : 0)))
    .forEach(({ t }) => t.tags.forEach(add));

  const counts = new Map();
  for (const raw of all.toLowerCase().match(/[a-z][a-z-]{3,}/g) || []) {
    const w = raw.replace(/-/g, '');
    if (STOP.has(raw) || STOP.has(w) || w.length < 4) continue;
    counts.set(w, (counts.get(w) || 0) + 1);
  }
  [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || b[0].length - a[0].length)
    .forEach(([w]) => out.length < max && add(w));

  return out.slice(0, max);
}

// "Convert this image into a cinematic anime illustration…" -> "a cinematic anime illustration…"
const RESTYLE = /^(convert|turn|make|transform|render|change|restyle|redraw|stylis[ez]e?)\b[^.]*?\binto\s+/i;
// Sentences aimed at the model, not at a reader: "Preserve the exact pose…", "Output one image…".
const IMPERATIVE =
  /^(keep|preserve|maintain|retain|do not|don'?t|never|always|output|apply|ensure|make sure|avoid|follow|match|use|using|include|exclude|remove|replace|set|every|each)\b/i;
const CONSTRAINT = /\b(must (have|be|stay|look|remain)|should be|hard constraint|exact(ly)? the same|exact same|same order|do not change)\b/i;
// Don't split on the dots inside "J.C. Staff" or "e.g.".
const SENTENCE = /(?<=[^A-Z][.!?])\s+(?=["'(]?[A-Z0-9])/;

/** A prompt reads as an instruction; this turns it back into something caption-shaped. */
export function promptSummary(prompt, max = 180) {
  const clean = String(prompt || '')
    .replace(/@[A-Za-z0-9_-]+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  const kept = clean
    .split(SENTENCE)
    .map((s) => s.trim().replace(RESTYLE, ''))
    .filter((s) => s && !IMPERATIVE.test(s) && !CONSTRAINT.test(s))
    // Stripping "Transform the background into …" can leave a sentence starting lower-case.
    .map((s) => s.charAt(0).toUpperCase() + s.slice(1));
  // If a prompt is nothing but instructions, a trimmed original beats an empty caption.
  let t = kept.join(' ').trim() || clean.replace(RESTYLE, '').trim();
  t = t.replace(/^(a|an)\s+/i, (m) => m.toUpperCase().slice(0, 1) + m.slice(1).toLowerCase());
  if (t.length > max) {
    const cut = t.slice(0, max);
    const stop = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf(', '), cut.lastIndexOf(' '));
    t = `${cut.slice(0, stop > max * 0.5 ? stop : max).trim().replace(/[,.]$/, '')}…`;
  }
  return t.charAt(0).toUpperCase() + t.slice(1);
}

/** Fill {summary} {prompt} {project} {name} {n} {tags} {date} in a caption template. */
export function buildCaption(template, ctx) {
  return String(template || '')
    .replace(/\{(\w+)\}/g, (m, key) => (key in ctx ? String(ctx[key] ?? '') : m))
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// Flow credit estimates. Flow's own "Generating will use N credits" line is the truth: whenever
// FlowBatch reads it, the per-video price is remembered for that plan, model, length and
// resolution and wins over the price list (CREDIT_TABLE), so a price change is picked up by itself.
import { app, emit, persistSettings, persistSession } from './app.js';
import { MODELS, CREDIT_TABLE } from './store.js';

export const PLANS = { free: 'Free', standard: 'Standard', plus: 'Plus', pro: 'Pro', ultra: 'Ultra' };

/** { id, source } — the plan chosen in Settings, else the one Flow's header shows. */
export function currentPlan() {
  const chosen = app.settings.plan;
  if (chosen && chosen !== 'auto') return { id: chosen, source: 'set in Settings' };
  const seen = app.session.flowInfo?.plan;
  return seen ? { id: seen, source: 'detected in Flow' } : { id: null, source: '' };
}

/** Our model id for one of Flow's labels ("Veo 3.1 - Fast" → veo-fast). */
export function modelIdOf(label, mode = 'video') {
  if (!label) return null;
  return (MODELS[mode] || []).find((m) => m.match && new RegExp(m.match, 'i').test(label))?.id || null;
}

const priceKey = (plan, model, duration, res) => [plan || '?', model, duration || '', res || ''].join('|');

/**
 * Keep what Flow reported — info: { plan, model, mode, duration, res, count, credits } from the
 * Flow agent — and learn its price. Returns true when a price was learned or changed.
 */
export function recordFlowInfo(info) {
  if (!info) return false;
  app.session.flowInfo = { ...(app.session.flowInfo || {}), ...Object.fromEntries(Object.entries(info).filter(([, v]) => v != null)), at: Date.now() };
  persistSession();
  emit('creditsChanged');
  const mode = info.mode || app.session.mode;
  const model = modelIdOf(info.model, mode);
  const count = info.count || Number(app.session.count) || 1;
  if (!model || !info.credits) return false;
  const key = priceKey(currentPlan().id, model, info.duration, info.res);
  const per = info.credits / count;
  if (app.settings.learnedCredits[key]?.per === per) return false;
  app.settings.learnedCredits[key] = { per, at: Date.now() };
  persistSettings();
  emit('creditsChanged');
  return true;
}

/** { per, source: 'flow' | 'list' } for one video, or null when unknown. */
export function pricePer(model, { duration, res } = {}) {
  const plan = currentPlan().id;
  const learned = app.settings.learnedCredits?.[priceKey(plan, model, duration, res)];
  if (learned) return { per: learned.per, source: 'flow' };
  const row = CREDIT_TABLE[model];
  if (!row) return null;
  let p = plan === 'ultra' && row.ultra != null ? row.ultra : row.base;
  if (typeof p === 'object') p = duration ? p[duration] ?? null : null;
  return p == null ? null : { per: p, source: 'list' };
}

/**
 * What the current prompts will cost in Flow: { total, per, source, prompts, count, model, label,
 * duration, res, plan } — or { unknown: reason, … } when no price is known.
 */
export function estimate(prompts) {
  const s = app.session;
  const info = s.flowInfo || {};
  const model = s.model !== 'keep' ? s.model : modelIdOf(info.model, s.mode);
  const label = (MODELS[s.mode] || []).find((m) => m.id === model)?.label || info.model || "Flow's current model";
  const count = Number(s.count) || 1;
  const plan = currentPlan();
  const base = { prompts, count, model, label, duration: info.duration, res: info.res, plan };
  if (!model) return { ...base, unknown: "which model Flow is set to isn't known yet" };
  const price = pricePer(model, info);
  if (!price) {
    const perLength = typeof CREDIT_TABLE[model]?.base === 'object';
    return { ...base, unknown: perLength ? 'its price depends on the video length, which Flow hasn’t shown yet' : `${label} isn't in the price list yet` };
  }
  return { ...base, ...price, total: price.per * count * prompts };
}

// ---------- balance (credits left) ----------

/** Keep what Flow shows: { credits, plan } from the agent's ping or balance read. */
export function recordBalance(r) {
  if (!r) return;
  const f = (app.session.flowInfo ||= {});
  let changed = false;
  if (r.plan && r.plan !== f.plan) (f.plan = r.plan), (changed = true);
  if (r.credits != null) {
    if (r.credits !== f.balance || f.balanceEstimated) changed = true;
    Object.assign(f, { balance: r.credits, balanceAt: Date.now(), balanceEstimated: false });
  }
  if (changed) {
    persistSession();
    emit('creditsChanged');
  }
}

/** { credits, at, estimated } or null when Flow hasn't shown a balance yet. */
export function balance() {
  const f = app.session.flowInfo;
  return f?.balance != null ? { credits: f.balance, at: f.balanceAt, estimated: !!f.balanceEstimated } : null;
}

/** After a Flow prompt finished: take its estimated cost off the balance until Flow shows the real one. */
export function spendOne() {
  const f = app.session.flowInfo;
  const e = estimate(1);
  if (f?.balance == null || e.unknown) return;
  f.balance = Math.max(0, f.balance - e.total);
  f.balanceEstimated = true;
  persistSession();
  emit('creditsChanged');
}

/** For Start: a warning when the run would cost more than the credits left, else null. */
export function balanceShortfall(prompts) {
  const b = balance();
  const e = estimate(prompts);
  if (!b || e.unknown || e.total <= b.credits) return null;
  const fits = Math.floor(b.credits / (e.per * e.count));
  return `This run needs about ${e.total.toLocaleString()} credits, but ${b.estimated ? 'about ' : ''}${b.credits.toLocaleString()} are left.\n\nOnly the first ${fits} prompt${fits === 1 ? '' : 's'} will likely run.`;
}

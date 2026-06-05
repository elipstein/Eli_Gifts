// docs/app.js — shared Supabase client + render/update helpers for both pages.
// Loaded as an ES module by her.html and index.html.
//
// ─── CONFIG ──────────────────────────────────────────────────────────────────
// Fill these in with your Supabase project values (Settings → API).
// Both are PUBLIC and safe to commit under this project's soft-privacy model
// (see README → "Privacy model"). The publishable key (sb_publishable_…) is the
// modern replacement for the legacy anon key.
import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';

const SUPABASE_URL = 'https://vusswtzedzeyyupmttoy.supabase.co;
const SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_ZUniAM46QvpY0aZCCblPGw_6OayJeaz';
// ─────────────────────────────────────────────────────────────────────────────

export const CONFIG_OK =
  !SUPABASE_URL.includes('YOUR-PROJECT') &&
  !SUPABASE_PUBLISHABLE_KEY.includes('REPLACE_ME');

export const supabase = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
  auth: { persistSession: false },
});

// ─── data helpers ────────────────────────────────────────────────────────────

// Fetch all ideas with a given status, newest first by `orderColumn`.
export async function fetchIdeas(status, orderColumn = 'created_at') {
  const { data, error } = await supabase
    .from('ideas')
    .select('*')
    .eq('status', status)
    .order(orderColumn, { ascending: false });
  if (error) throw error;
  return data ?? [];
}

// Update an idea's status and stamp status_changed_at.
export async function setStatus(id, status) {
  const { error } = await supabase
    .from('ideas')
    .update({ status, status_changed_at: new Date().toISOString() })
    .eq('id', id);
  if (error) throw error;
}

// Insert one of Eli's own ideas (used by index.html in step 4).
export async function addIdea(fields) {
  const { error } = await supabase
    .from('ideas')
    .insert({ ...fields, source: 'eli', status: 'new' });
  if (error) throw error;
}

// ─── tiny DOM helpers ────────────────────────────────────────────────────────

// el('button', { class: 'btn', text: 'Keep', onclick: fn }, [childNodes])
export function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined) continue;
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v);
  }
  for (const c of [].concat(children)) {
    if (c === null || c === undefined) continue;
    node.append(c.nodeType ? c : document.createTextNode(c));
  }
  return node;
}

// Build an idea card. `actions` is an optional element appended at the bottom
// (e.g. Keep/Pass buttons on her page). Shared by both pages.
export function ideaCard(idea, actions = null) {
  const card = el('article', { class: 'card' });

  const head = el('div', { class: 'card-head' }, [
    el('h3', { class: 'card-title', text: idea.title || 'Untitled' }),
  ]);
  if (idea.category) head.append(el('span', { class: 'chip', text: idea.category }));
  card.append(head);

  if (idea.description) card.append(el('p', { class: 'card-desc', text: idea.description }));

  const meta = el('div', { class: 'card-meta' });
  if (idea.est_price) meta.append(el('span', { class: 'price', text: idea.est_price }));
  if (idea.url) {
    meta.append(el('a', {
      class: 'buy', href: idea.url, target: '_blank', rel: 'noopener noreferrer', text: 'View ↗',
    }));
  }
  if (meta.childNodes.length) card.append(meta);

  if (actions) card.append(actions);
  return card;
}

// Replace a container's contents with a single muted message line.
export function showMessage(container, text) {
  container.replaceChildren(el('p', { class: 'message', text }));
}

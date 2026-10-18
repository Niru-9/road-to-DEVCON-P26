/* Headline to Market — editor UI. Vanilla JS, no build step.
 * Untrusted content (headlines, snippets, model output) is rendered via
 * textContent / DOM APIs only — never via innerHTML. */
'use strict';

const $ = (sel) => document.querySelector(sel);

const state = {
  lastInput: { headline: '', snippet: '' },
  result: null, // last generated draft record
  editing: false,
};

function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v);
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined) continue;
    el.append(child.nodeType ? child : document.createTextNode(String(child)));
  }
  return el;
}

function setStatus(kind, text) {
  const el = $('#status');
  el.className = `status ${kind}`;
  el.textContent = text;
}

function clearStatus() {
  const el = $('#status');
  el.className = 'status hidden';
  el.textContent = '';
}

// --- date helpers -----------------------------------------------------------

function isoToLocalInput(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function localInputToIso(value) {
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? '' : d.toISOString();
}

function fmtDate(iso) {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
}

// --- API --------------------------------------------------------------------

async function api(path, options = {}) {
  const res = await fetch(path, {
    headers: { 'content-type': 'application/json' },
    ...options,
  });
  return await res.json(); // always a { ok, ... } envelope
}

// --- rendering --------------------------------------------------------------

function renderResult() {
  const container = $('#result');
  container.replaceChildren();
  const result = state.result;
  if (!result) return;

  if (result.kind === 'error') {
    container.append(errorCard(result));
    return;
  }
  const draft = result.draft;
  container.append(draft.status === 'discarded' ? discardedCard(draft) : draftCard(draft));
}

function errorCard(result) {
  const { error } = result;
  return h('div', { class: 'card' },
    h('h2', {}, 'Draft failed — nothing was saved ',
      h('span', { class: 'badge unresolvable' }, error.kind)),
    h('p', {}, error.message),
    error.details && error.details.length
      ? h('ul', { class: 'error-details' }, error.details.map((d) => h('li', {}, d)))
      : null,
    h('div', { class: 'actions' },
      h('button', { onclick: () => retryGenerate() }, 'Retry'),
      h('button', { class: 'secondary', onclick: () => showManualForm() }, 'Draft manually'),
    ),
  );
}

function discardedCard(draft) {
  return h('div', { class: 'card' },
    h('div', { class: 'draft-head' },
      h('span', { class: 'draft-headline' }, draft.headline),
      h('span', {},
        h('span', { class: `badge ${draft.outcome}` }, draft.outcome), ' ',
        h('span', { class: 'badge discarded' }, 'discarded')),
    ),
    h('p', { class: 'meta' }, 'This draft was discarded.'),
  );
}

function draftCard(draft) {
  const card = h('div', { class: 'card' },
    h('div', { class: 'draft-head' },
      h('span', { class: 'draft-headline' }, draft.headline),
      h('span', {},
        h('span', { class: `badge ${draft.outcome}` }, draft.outcome), ' ',
        h('span', { class: `badge ${draft.status}` }, draft.status === 'approved' ? 'live' : draft.status)),
    ),
  );

  if (draft.outcome === 'unresolvable') {
    card.append(
      h('div', { class: 'reason-box' }, h('strong', {}, 'Why this can’t become a market: '), draft.payload.reason),
      h('p', { class: 'meta' }, 'No market was created. Discard this explanation when you’re done with it.'),
      h('div', { class: 'actions' },
        h('button', { class: 'danger', onclick: () => discardDraft(draft.id) }, 'Discard'),
      ),
    );
    return card;
  }

  const p = draft.payload;
  card.append(h('p', { class: 'question' }, p.question));

  if (draft.status === 'approved') {
    card.append(h('p', { class: 'meta' }, `This market is LIVE (approved ${fmtDate(draft.updatedAt)}).`));
  }

  if (state.editing && draft.status === 'pending') {
    card.append(editForm(draft));
  } else {
    card.append(
      h('dl', {},
        h('dt', {}, 'Closes'), h('dd', {}, fmtDate(p.closeTime)),
        h('dt', {}, 'Resolves via'), h('dd', {}, p.resolutionSource),
        h('dt', {}, 'YES means'), h('dd', {}, p.yesCriteria),
        h('dt', {}, 'NO means'), h('dd', {}, p.noCriteria),
        h('dt', {}, 'Edge cases'), h('dd', {}, h('ul', {}, p.edgeCases.map((e) => h('li', {}, e)))),
      ),
    );
    if (draft.status === 'pending') {
      card.append(h('div', { class: 'actions' },
        h('button', { onclick: () => { state.editing = true; renderResult(); } }, 'Edit'),
        h('button', { class: 'secondary', onclick: () => approveDraft(draft.id) }, 'Approve — go live'),
        h('button', { class: 'danger', onclick: () => discardDraft(draft.id) }, 'Discard'),
      ));
    }
  }
  return card;
}

function marketForm(idPrefix, values, onSave) {
  const fields = {
    question: h('input', { type: 'text', id: `${idPrefix}-q`, value: values.question ?? '' }),
    closeTime: h('input', { type: 'datetime-local', id: `${idPrefix}-close`, value: isoToLocalInput(values.closeTime ?? '') }),
    resolutionSource: h('input', { type: 'text', id: `${idPrefix}-src`, value: values.resolutionSource ?? '', placeholder: 'e.g. Reserve Bank of India (rbi.org.in)' }),
    yesCriteria: h('textarea', { id: `${idPrefix}-yes`, rows: '2' }, values.yesCriteria ?? ''),
    noCriteria: h('textarea', { id: `${idPrefix}-no`, rows: '2' }, values.noCriteria ?? ''),
    edgeCases: h('textarea', { id: `${idPrefix}-edge`, rows: '4', placeholder: 'One edge-case rule per line' }, (values.edgeCases ?? []).join('\n')),
  };
  const form = h('div', { class: 'edit-panel' },
    h('label', { for: `${idPrefix}-q` }, 'Question'), fields.question,
    h('label', { for: `${idPrefix}-close` }, 'Close date & time'), fields.closeTime,
    h('label', { for: `${idPrefix}-src` }, 'Resolution source'), fields.resolutionSource,
    h('label', { for: `${idPrefix}-yes` }, 'YES criteria'), fields.yesCriteria,
    h('label', { for: `${idPrefix}-no` }, 'NO criteria'), fields.noCriteria,
    h('label', { for: `${idPrefix}-edge` }, 'Edge-case rules'), fields.edgeCases,
    h('div', { class: 'actions' },
      h('button', { onclick: () => onSave({
        question: fields.question.value.trim(),
        closeTime: localInputToIso(fields.closeTime.value),
        resolutionSource: fields.resolutionSource.value.trim(),
        yesCriteria: fields.yesCriteria.value.trim(),
        noCriteria: fields.noCriteria.value.trim(),
        edgeCases: fields.edgeCases.value.split('\n').map((s) => s.trim()).filter(Boolean),
      }) }, 'Save'),
    ),
  );
  return form;
}

function editForm(draft) {
  return marketForm('edit', draft.payload, (patch) => saveEdit(draft.id, patch));
}

function showManualForm() {
  state.result = null;
  const container = $('#result');
  container.replaceChildren(
    h('div', { class: 'card' },
      h('h2', {}, 'Draft manually'),
      h('p', { class: 'meta' }, 'Fill in the market by hand. It will be saved as a pending draft — still not live until you approve it.'),
      marketForm('manual', {}, (patch) => saveManual(state.lastInput.headline, patch)),
    ),
  );
}

// --- actions ---------------------------------------------------------------

async function runGenerate() {
  const headline = $('#headline').value.trim();
  const snippet = $('#snippet').value.trim();
  if (!headline) {
    setStatus('error', 'Please paste a headline first.');
    return;
  }
  state.lastInput = { headline, snippet };
  state.editing = false;
  clearStatus();
  $('#result').replaceChildren();
  $('#generate-btn').disabled = true;
  setStatus('loading', 'Asking the model for a draft…');

  const envelope = await api('/api/generate', {
    method: 'POST',
    body: JSON.stringify({ headline, snippet }),
  });

  $('#generate-btn').disabled = false;
  clearStatus();
  if (envelope.ok) {
    state.result = { kind: 'draft', draft: envelope.draft };
  } else {
    // Validation/model failure -> defined fallback state with retry + manual path.
    state.result = { kind: 'error', error: envelope.error };
  }
  renderResult();
  refreshDrafts();
}

async function retryGenerate() {
  $('#headline').value = state.lastInput.headline;
  $('#snippet').value = state.lastInput.snippet;
  await runGenerate();
}

async function saveEdit(id, patch) {
  const envelope = await api(`/api/drafts/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: JSON.stringify(patch),
  });
  if (envelope.ok) {
    state.editing = false;
    state.result = { kind: 'draft', draft: envelope.draft };
    clearStatus();
  } else {
    setStatus('error', envelope.error.message +
      (envelope.error.details?.length ? ` — ${envelope.error.details.join('; ')}` : ''));
  }
  renderResult();
  refreshDrafts();
}

async function saveManual(headline, patch) {
  clearStatus();
  setStatus('loading', 'Saving your manual draft…');
  const envelope = await api('/api/drafts', {
    method: 'POST',
    body: JSON.stringify({ headline, ...patch }),
  });
  clearStatus();
  if (envelope && envelope.ok) {
    state.result = { kind: 'draft', draft: envelope.draft };
    setStatus('loading', 'Manual draft saved as pending — approve it to make it live.');
  } else {
    setStatus('error', (envelope?.error?.message ?? 'Could not save the manual draft.') +
      (envelope?.error?.details?.length ? ` — ${envelope.error.details.join('; ')}` : ''));
  }
  renderResult();
  refreshDrafts();
}

async function approveDraft(id) {
  const envelope = await api(`/api/drafts/${encodeURIComponent(id)}/approve`, { method: 'POST' });
  if (envelope.ok) {
    state.result = { kind: 'draft', draft: envelope.draft };
    setStatus('loading', 'Market approved — it is now live.');
  } else {
    setStatus('error', envelope.error.message);
  }
  renderResult();
  refreshDrafts();
}

async function discardDraft(id) {
  const envelope = await api(`/api/drafts/${encodeURIComponent(id)}/discard`, { method: 'POST' });
  if (envelope.ok) {
    state.result = { kind: 'draft', draft: envelope.draft };
    clearStatus();
  } else {
    setStatus('error', envelope.error.message);
  }
  renderResult();
  refreshDrafts();
}

async function refreshDrafts() {
  const envelope = await api('/api/drafts');
  const section = $('#drafts-section');
  const list = $('#drafts-list');
  list.replaceChildren();
  if (!envelope.ok || envelope.drafts.length === 0) {
    section.classList.add('hidden');
    return;
  }
  section.classList.remove('hidden');
  for (const draft of envelope.drafts) {
    const summary =
      draft.outcome === 'market' ? draft.payload.question : draft.payload.reason;
    list.append(h('div', { class: 'card' },
      h('div', { class: 'draft-head' },
        h('span', { class: 'draft-headline' }, draft.headline),
        h('span', {},
          h('span', { class: `badge ${draft.outcome}` }, draft.outcome), ' ',
          h('span', { class: `badge ${draft.status}` }, draft.status === 'approved' ? 'live' : draft.status)),
      ),
      h('p', { class: 'question' }, summary),
      h('p', { class: 'meta' }, `Created ${fmtDate(draft.createdAt)}${draft.snippet ? ' · snippet provided' : ''}`),
      draft.status === 'pending' && draft.outcome === 'market'
        ? h('div', { class: 'actions' },
            h('button', { class: 'secondary', onclick: () => approveDraft(draft.id) }, 'Approve — go live'),
            h('button', { class: 'danger', onclick: () => discardDraft(draft.id) }, 'Discard'),
          )
        : null,
    ));
  }
}

$('#generate-form').addEventListener('submit', (e) => {
  e.preventDefault();
  void runGenerate();
});

refreshDrafts();

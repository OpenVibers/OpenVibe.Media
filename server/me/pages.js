/**
 * OpenVibe.Media — the object explorer's pages (roadmap WS-G task 12): /me, /me/objects/:id, /me/ops.
 *
 * Server-rendered in the OpenVibe Frame (public/page-frame.js), complete without JavaScript: the first
 * page of objects, the usage table, filters as a GET form, pages as links, and the operator recompute
 * as a POST form. /me/app.js (client.js) only enhances /me: filters and "load more" without a reload,
 * and upload progress polled while something is uploading. Every page is noindex and private.
 * Strings from the database are escaped (esc) and never reach a script.
 */
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const pageFrame = require('../public/page-frame');
const model = require('../objects/model');

const { esc, SITE_NAME } = pageFrame;

// The enhancement script, read once: served as /me/app.js?v=<its hash> (routes.js).
const CLIENT_PATH = path.join(__dirname, 'client.js');
const CLIENT_SOURCE = fs.readFileSync(CLIENT_PATH, 'utf8');
const CLIENT_VERSION = crypto.createHash('sha256').update(CLIENT_SOURCE).digest('hex').slice(0, 12);

const KIND_LABEL = { vod: 'VOD', clip: 'Clip', file: 'File', thumbnail: 'Thumbnail', screenshot: 'Screenshot', avatar: 'Avatar', asset: 'Asset' };
const STATUS_LABEL = { uploading: 'Uploading', ready: 'Ready', failed: 'Failed', archived: 'Archived', deleted: 'Deleted' };
const REASON_TEXT = {
    no_object: 'no object', deleted: 'deleted', metadata_unreadable: 'metadata unreadable', failed: 'failed', archived: 'archived',
    recording: 'still recording', processing: 'still processing', verification_pending: 'copy not checked yet', no_verified_copy: 'no verified copy',
};

function fmtBytes(n) {
    n = Number(n) || 0;
    if (n < 1024) return `${n} B`;
    const units = ['KB', 'MB', 'GB', 'TB'];
    let v = n, i = -1;
    do { v /= 1024; i++; } while (v >= 1024 && i < units.length - 1);
    return `${v >= 100 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}
function fmtWhen(isoStr) {
    if (!isoStr) return '';
    const d = new Date(isoStr);
    return Number.isNaN(d.getTime()) ? '' : `${d.toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}
const num = (n) => Number(n || 0).toLocaleString('en-US');
const displayName = (it) => it.title || it.filename || `${KIND_LABEL[it.kind] || it.kind} ${it.id.slice(-6)}`;

/** A table that becomes one card per row (each cell labelled from data-label) on narrow screens. */
const stackRules = (t) => `
    ${t} thead { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); }
    ${t}, ${t} tbody, ${t} tr, ${t} td, ${t} th { display: block; width: 100%; }
    ${t} tr { border: 1px solid var(--line); border-radius: 10px; padding: .35rem .6rem; margin: 0 0 .6rem; background: var(--panel); }
    ${t} td, ${t} th { border: 0; padding: .25rem 0; display: flex; gap: .8rem; justify-content: space-between; text-align: right; }
    ${t} td::before, ${t} th[data-label]::before { content: attr(data-label); color: var(--muted); font-weight: 400; text-align: left; flex: none; }
    ${t} td > *, ${t} th > * { min-width: 0; }`;

const CSS = `
  main { max-width: 1240px; }
  h2 { font-size: 1.08rem; margin: 1.6rem 0 .5rem; }
  h3 { font-size: .98rem; margin: 1.1rem 0 .4rem; }
  .sr { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0; }
  .hint { color: var(--muted); font-size: .88rem; margin: 0 0 .6rem; }
  a:focus-visible, button:focus-visible, input:focus-visible, select:focus-visible, summary:focus-visible { outline: 3px solid var(--link); outline-offset: 2px; }
  button.btn { border: 0; cursor: pointer; font: inherit; font-weight: 600; font-size: .9rem; }
  /* The accent darkened a little: white on the default blue (#3b82f6) is 3.7:1, under WCAG AA for this size. */
  .btn:not(.ghost) { background: var(--acc); background: color-mix(in srgb, var(--acc) 82%, #000); }
  .grid { width: 100%; border-collapse: collapse; font-size: .88rem; margin: 0 0 .8rem; }
  .grid th, .grid td { text-align: left; padding: .45rem .5rem; border-bottom: 1px solid var(--line); vertical-align: top; overflow-wrap: break-word; }
  .grid tbody th, .grid .id, .grid .sub { overflow-wrap: anywhere; }
  .grid tbody th { font-weight: 400; }
  .grid tbody th a { font-weight: 600; }
  .grid thead th { color: var(--muted); font-weight: 600; font-size: .8rem; }
  .grid td.n, .grid th.n { text-align: right; white-space: nowrap; }
  .grid tr.total td, .grid tr.total th { font-weight: 600; }
  .id { font: 12px/1.4 ui-monospace, Menlo, monospace; color: var(--muted); display: block; }
  .sub { color: var(--muted); font-size: .8rem; display: block; }
  .tag { display: inline-block; font-size: .74rem; line-height: 1.5; padding: 0 .45rem; border-radius: 999px; border: 1px solid var(--line); margin: 0 .25rem .25rem 0; white-space: nowrap; }
  .tag.ok { border-color: color-mix(in srgb, #22c55e 55%, var(--line)); }
  .tag.no { border-style: dashed; color: var(--muted); }
  .tag.warn { border-color: color-mix(in srgb, #f59e0b 60%, var(--line)); }
  .up { display: grid; gap: .2rem; min-width: 9rem; }
  .up progress { width: 100%; height: .6rem; accent-color: var(--acc); }
  .filters { display: flex; flex-wrap: wrap; gap: .6rem .8rem; align-items: flex-end; margin: 0 0 .8rem; }
  .filters div { display: grid; gap: .2rem; }
  .filters label { font-size: .8rem; color: var(--muted); }
  .filters input, .filters select { font: inherit; font-size: .9rem; padding: .4rem .5rem; border-radius: 8px; border: 1px solid var(--line); background: var(--panel); color: var(--text); max-width: 100%; }
  .filters input { width: 16rem; }
  .filters .go { display: flex; gap: .5rem; flex-direction: row; }
  .pager { display: flex; flex-wrap: wrap; gap: .5rem; align-items: center; margin: .4rem 0 1rem; }
  .empty { color: var(--muted); }
  dl.facts { display: grid; grid-template-columns: max-content 1fr; gap: .3rem 1rem; margin: 0 0 1rem; font-size: .9rem; }
  dl.facts dt { color: var(--muted); }
  dl.facts dd { margin: 0; overflow-wrap: anywhere; }
  .cols { display: grid; grid-template-columns: repeat(auto-fit, minmax(12rem, 1fr)); gap: .6rem 1rem; }
  .card { background: var(--panel); border: 1px solid var(--line); border-radius: 12px; padding: .7rem .9rem; }
  .card b { display: block; font-size: 1.2rem; }
  .card span { color: var(--muted); font-size: .82rem; }
  pre.err { white-space: pre-wrap; overflow-wrap: anywhere; margin: 0; font: 12px/1.4 ui-monospace, Menlo, monospace; }
  @media (max-width: 760px) {
${stackRules('.grid.stack')}
    .filters input { width: 100%; }
    .filters div { flex: 1 1 100%; }
  }
  @media (min-width: 761px) and (max-width: 1060px) {
${stackRules('.grid.stack.objects')}
  }`;

function doc({ title, description, body, script = false }) {
    return pageFrame.page({
        seo: { title: `${title} — ${SITE_NAME}`, description, robots: 'noindex, nofollow', twitterCard: 'summary' },
        css: CSS,
        body: body + (script ? `\n<script src="/me/app.js?v=${CLIENT_VERSION}" defer></script>` : ''),
        footer: { variant: 'compact' },
    });
}

/** Query string for /me with these filters (+ a cursor). */
function query(filters = {}, extra = {}) {
    const p = new URLSearchParams();
    for (const k of ['q', 'kind', 'status', 'app']) if (filters[k]) p.set(k, filters[k]);
    if (filters.limit && filters.limit !== 25) p.set('limit', String(filters.limit));
    for (const [k, v] of Object.entries(extra)) if (v) p.set(k, v);
    const s = p.toString();
    return s ? `?${s}` : '';
}

// ── Signed out / not allowed ─────────────────────────────────

function renderSignIn({ next = '/me', heading = 'Your media', reason = null } = {}) {
    const body = `
  <h1>${esc(heading)}</h1>
  <p class="note">${reason ? `${esc(reason)} ` : ''}Sign in with your OpenVibe account to see the media you own: uploads in progress, copies, derivatives, visibility and usage.</p>
  <div class="actions"><a class="btn" href="/auth/login?next=${encodeURIComponent(next)}">Sign in</a></div>`;
    return doc({ title: heading, description: 'Sign in to see the media you own on OpenVibe.Media.', body });
}

function renderForbidden({ person, heading = 'Media operations', need }) {
    const body = `
  <h1>${esc(heading)}</h1>
  <p class="note">Signed in as <strong>${esc(person.username ? `@${person.username}` : person.subject)}</strong>. This page is for OpenVibe operators (the staff capability <code>${esc(need)}</code>).</p>
  <div class="actions"><a class="btn ghost" href="/me">Your media</a></div>`;
    return doc({ title: heading, description: 'Operator views of OpenVibe.Media.', body });
}

function renderDrill(heading = 'Your media') {
    return doc({ title: heading, description: 'Restore-drill instance.', body: `<h1>${esc(heading)}</h1><p class="note">This is a restore-drill instance (MEDIA_DRILL): nobody signs in here.</p>` });
}

// ── Explorer (/me) ───────────────────────────────────────────

function statusCell(it) {
    const out = [`<span class="st">${esc(STATUS_LABEL[it.lifecycle_status] || it.lifecycle_status)}</span>`];
    const u = it.upload;
    if (u) {
        const label = `Upload of ${displayName(it)}`;
        const bar = u.percent != null
            ? `<progress max="100" value="${u.percent}" aria-label="${esc(label)}">${u.percent}%</progress>`
            : `<progress aria-label="${esc(label)}"></progress>`;
        const words = u.waiting_for === 'complete' ? 'all bytes stored, waiting for the app to complete it'
            : u.waiting_for === 'assembly' ? 'assembling the parts'
                : `${u.percent != null ? `${u.percent}% · ` : ''}${fmtBytes(u.received_bytes)}${u.declared_bytes ? ` of ${fmtBytes(u.declared_bytes)}` : ' received'}`
                + (u.method === 'multipart' ? ` · ${u.parts_received} of ${u.parts_expected} parts` : '');
        out.push(`<div class="up" data-upload="${esc(it.id)}">${bar}<span class="sub up-text">${esc(words)}</span>${u.expires_at ? `<span class="sub">unfinished uploads fail after ${esc(fmtWhen(u.expires_at))}</span>` : ''}</div>`);
    }
    if (it.failure) out.push(`<span class="sub">${esc(it.failure.replace(/_/g, ' '))}</span>`);
    if (it.deleted) out.push(`<span class="sub">${it.deleted.purged ? 'bytes purged' : it.deleted.retention_until ? `kept until ${esc(fmtWhen(it.deleted.retention_until))}` : 'kept for the retention period'}</span>`);
    if (it.held) out.push('<span class="tag warn">Held</span>');
    return out.join(' ');
}

function readinessCell(it) {
    const r = it.readiness || {};
    const tags = [
        r.metadata ? '<span class="tag ok">metadata</span>' : '<span class="tag no">no metadata</span>',
        r.bytes_verified ? '<span class="tag ok">bytes verified</span>' : '<span class="tag no">bytes not verified</span>',
    ];
    if (it.kind === 'vod' || it.kind === 'clip') {
        tags.push(r.playable ? '<span class="tag ok">playable</span>' : `<span class="tag no">not playable${r.reason && REASON_TEXT[r.reason] ? `: ${esc(REASON_TEXT[r.reason])}` : ''}</span>`);
    }
    return tags.join('');
}

function objectRow(it) {
    const name = displayName(it);
    return `<tr data-id="${esc(it.id)}" data-status="${esc(it.lifecycle_status)}"${it.upload ? ' data-uploading="1"' : ''}>
      <th scope="row" data-label="Name"><span><a href="/me/objects/${esc(it.id)}">${esc(name)}</a><span class="id">${esc(it.id)}</span>${it.mime_type ? `<span class="sub">${esc(it.mime_type)}</span>` : ''}</span></th>
      <td data-label="Kind">${esc(KIND_LABEL[it.kind] || it.kind)}</td>
      <td data-label="Tenant"><span>${esc(it.tenant.name)}${it.tenant.sandbox ? ' <span class="tag">sandbox</span>' : ''}<span class="sub">${esc(it.namespace)}</span></span></td>
      <td data-label="Size" class="n">${esc(fmtBytes(it.size_bytes))}</td>
      <td data-label="Visibility"><span>${esc(it.visibility)}${it.public_url ? ` <a href="${esc(it.public_url)}">open<span class="sr"> ${esc(name)}</span></a>` : ''}</span></td>
      <td data-label="Status"><span>${statusCell(it)}</span></td>
      <td data-label="Readiness"><span>${readinessCell(it)}</span></td>
      <td data-label="Derivatives" class="n">${num(it.derivatives)}</td>
      <td data-label="Created"><span>${esc(fmtWhen(it.created_at))}</span></td>
    </tr>`;
}

function usageTable(usage) {
    if (!usage.tenants.length) return '<p class="empty">You own no media objects yet.</p>';
    const byStatus = (g, s) => g.by_status[s] || { objects: 0, bytes: 0 };
    const cells = (g) => `<td data-label="Objects" class="n">${num(g.objects)}</td>
        <td data-label="Stored" class="n">${esc(fmtBytes(g.stored_bytes))}</td>
        <td data-label="Uploading" class="n">${num(byStatus(g, 'uploading').objects)}${byStatus(g, 'uploading').objects ? ` · ${esc(fmtBytes(byStatus(g, 'uploading').bytes))}` : ''}</td>
        <td data-label="Failed" class="n">${num(byStatus(g, 'failed').objects)}</td>
        <td data-label="Deleted" class="n">${num(byStatus(g, 'deleted').objects)}${byStatus(g, 'deleted').objects ? ` · ${esc(fmtBytes(byStatus(g, 'deleted').bytes))}` : ''}</td>`;
    const rows = [];
    for (const t of usage.tenants) {
        for (const ns of t.namespaces) {
            rows.push(`<tr><th scope="row" data-label="Namespace"><span>${esc(t.name)}${t.sandbox ? ' <span class="tag">sandbox</span>' : ''}<span class="sub">${esc(ns.namespace)}</span></span></th>${cells(ns)}</tr>`);
        }
        if (t.namespaces.length > 1) rows.push(`<tr class="total"><th scope="row" data-label="Tenant">${esc(t.name)}, all namespaces</th>${cells(t)}</tr>`);
    }
    if (usage.tenants.length > 1) rows.push(`<tr class="total"><th scope="row" data-label="Total">All tenants</th>${cells(usage.totals)}</tr>`);
    return `<table class="grid stack usage">
    <caption class="sr">Your objects and bytes per tenant and namespace</caption>
    <thead><tr><th scope="col">Tenant and namespace</th><th scope="col" class="n">Objects</th><th scope="col" class="n">Stored</th><th scope="col" class="n">Uploading</th><th scope="col" class="n">Failed</th><th scope="col" class="n">Deleted, kept until purge</th></tr></thead>
    <tbody>${rows.join('\n')}</tbody>
  </table>`;
}

function filtersForm(filters, tenants) {
    const opt = (v, label, cur) => `<option value="${esc(v)}"${String(cur || '') === String(v) ? ' selected' : ''}>${esc(label)}</option>`;
    return `<form class="filters" id="me-filters" method="get" action="/me" role="search" aria-label="Filter your objects">
    <div><label for="f-q">Search</label><input id="f-q" name="q" type="search" maxlength="100" value="${esc(filters.q || '')}" placeholder="Name, title, type or med_ id"></div>
    <div><label for="f-kind">Kind</label><select id="f-kind" name="kind">${opt('', 'Any kind', filters.kind)}${model.KINDS.map(k => opt(k, KIND_LABEL[k] || k, filters.kind)).join('')}</select></div>
    <div><label for="f-status">Status</label><select id="f-status" name="status">${opt('', 'Not deleted', filters.status)}${model.LIFECYCLES.map(s => opt(s, STATUS_LABEL[s] || s, filters.status)).join('')}${opt('all', 'All, deleted included', filters.status)}</select></div>
    <div><label for="f-app">Tenant</label><select id="f-app" name="app">${opt('', 'All tenants', filters.app)}${tenants.map(t => opt(t.app_id, t.name, filters.app)).join('')}</select></div>
    <div class="go"><button type="submit" class="btn">Apply</button><a class="btn ghost" href="/me">Clear</a></div>
  </form>`;
}

function objectsTable(items) {
    return `<table class="grid stack objects" id="me-objects"${items.length ? '' : ' hidden'}>
    <caption class="sr">Your objects, newest first</caption>
    <thead><tr><th scope="col">Name</th><th scope="col">Kind</th><th scope="col">Tenant and namespace</th><th scope="col" class="n">Size</th><th scope="col">Visibility</th><th scope="col">Status</th><th scope="col">Readiness</th><th scope="col" class="n">Derivatives</th><th scope="col">Created</th></tr></thead>
    <tbody>${items.map(objectRow).join('\n')}</tbody>
  </table>`;
}

function renderExplorer({ person, list, usage, filters, canOps = false }) {
    const who = person.username ? `@${person.username}` : person.subject;
    const tenants = usage.tenants.map(t => ({ app_id: t.app_id, name: t.name }));
    if (filters.app && !tenants.some(t => t.app_id === filters.app)) tenants.push({ app_id: filters.app, name: filters.app });
    const firstHref = `/me${query(filters)}`;
    const nextHref = list.next_cursor ? `/me${query(filters, { cursor: list.next_cursor })}` : null;
    const filtered = !!(filters.q || filters.kind || filters.status || filters.app);
    const body = `
  <h1>Your media</h1>
  <p class="meta"><span>Signed in as <strong>${esc(who)}</strong></span><span aria-hidden="true">·</span><span>objects you own, in every app that stores media here</span>${canOps ? '<span aria-hidden="true">·</span><a href="/me/ops">Operator views</a>' : ''}</p>
  <p class="note" id="me-readonly"><strong>Read-only.</strong> Change an object's visibility, delete it or restore it in the app that stored it (its tenant below): Media's object API takes those changes from the app, not from your sign-in.</p>
  <section aria-labelledby="usage-h">
    <h2 id="usage-h">Usage</h2>
    <p class="hint">${esc(usage.note)} Uploading counts the declared sizes; deleted objects are kept for the retention period before their bytes are purged.</p>
    ${usageTable(usage)}
  </section>
  <section aria-labelledby="objects-h">
    <h2 id="objects-h">Objects</h2>
    ${filtersForm(filters, tenants)}
    <p id="me-status" class="hint" role="status" aria-live="polite">${list.objects.length ? `${num(list.objects.length)} object${list.objects.length === 1 ? '' : 's'} shown, newest first.` : ''}</p>
    ${objectsTable(list.objects)}
    <p class="empty" id="me-empty"${list.objects.length ? ' hidden' : ''}>${filtered ? 'No objects match these filters.' : 'No objects yet.'}</p>
    <nav class="pager" aria-label="Pages of objects">
      ${filters.cursor ? `<a class="btn ghost" href="${esc(firstHref)}">Newest</a>` : ''}
      <a class="btn ghost" id="me-next" rel="next" href="${esc(nextHref || firstHref)}"${nextHref ? '' : ' hidden'}>Next page</a>
    </nav>
  </section>`;
    return doc({ title: 'Your media', description: 'The media you own on OpenVibe.Media: uploads, copies, derivatives, visibility and usage.', body, script: true });
}

// ── Detail (/me/objects/:id) ─────────────────────────────────

function table(caption, head, rows, { stack = true, numeric = [] } = {}) {
    if (!rows.length) return '';
    const th = head.map((h, i) => `<th scope="col"${numeric.includes(i) ? ' class="n"' : ''}>${esc(h)}</th>`).join('');
    const tr = rows.map(r => `<tr>${r.map((c, i) => `<td data-label="${esc(head[i])}"${numeric.includes(i) ? ' class="n"' : ''}>${c}</td>`).join('')}</tr>`).join('\n');
    return `<table class="grid${stack ? ' stack' : ''}"><caption class="sr">${esc(caption)}</caption><thead><tr>${th}</tr></thead><tbody>${tr}</tbody></table>`;
}

function renderDetail({ person, obj }) {
    const name = displayName(obj);
    const facts = [
        ['Id', `<code>${esc(obj.id)}</code>`],
        ['Kind', esc(KIND_LABEL[obj.kind] || obj.kind)],
        ['Tenant', `${esc(obj.tenant.name)} <span class="sub">${esc(obj.app_id)}${obj.tenant.sandbox ? ', sandbox' : ''}</span>`],
        ['Namespace', esc(obj.namespace)],
        ['File name', obj.filename ? esc(obj.filename) : '<span class="sub">none</span>'],
        ['Type', esc(obj.mime_type || 'unknown')],
        ['Size', `${esc(fmtBytes(obj.size_bytes))} <span class="sub">${num(obj.size_bytes)} bytes</span>`],
        ['Visibility', `${esc(obj.visibility)}${obj.public_url ? ` · <a href="${esc(obj.public_url)}">open</a>` : ''}`],
        ['Status', statusCell(obj)],
        ['Readiness', readinessCell(obj)],
        ['SHA-256', obj.content_hash ? `<code class="id">${esc(obj.content_hash)}</code>` : '<span class="sub">not computed yet</span>'],
        ['Written through', obj.managed_by === 'v1' ? 'the app\'s v1 API (a VOD, clip, file or screenshot row)' : 'the object API (v2)'],
        ['Created', esc(fmtWhen(obj.created_at))],
        ['Updated', esc(fmtWhen(obj.updated_at))],
    ];
    if (obj.source) facts.push(['Made from', `<a href="/me/objects/${esc(obj.source.id)}">${esc(obj.source.id)}</a> <span class="sub">${esc(obj.source.relation.replace(/_/g, ' '))}</span>`]);
    const body = `
  <p><a href="/me">← Your media</a></p>
  <h1>${esc(name)}</h1>
  <p class="meta"><span>Signed in as <strong>${esc(person.username ? `@${person.username}` : person.subject)}</strong></span></p>
  <dl class="facts">${facts.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${v}</dd>`).join('')}</dl>
  <section aria-labelledby="copies-h">
    <h2 id="copies-h">Copies</h2>
    ${table('Where the bytes are', ['Provider', 'Class', 'State', 'Size', 'Checked'], obj.locations.map(l => [
        `${esc(l.provider)}${l.canonical ? ' <span class="tag">canonical</span>' : ''}`, esc(l.storage_class || ''), esc(l.state), esc(fmtBytes(l.size_bytes)), esc(fmtWhen(l.verified_at) || 'not yet'),
    ]), { numeric: [3] }) || '<p class="empty">No stored copy.</p>'}
  </section>
  <section aria-labelledby="derived-h">
    <h2 id="derived-h">Derivatives</h2>
    ${table('Objects made from this one', ['Object', 'Made as', 'Kind', 'Status', 'Size'], obj.derivative_list.map(d => [
        d.mine ? `<a href="/me/objects/${esc(d.id)}">${esc(d.id)}</a>` : `<code class="id">${esc(d.id)}</code>`, esc(d.name), esc(KIND_LABEL[d.kind] || d.kind), esc(STATUS_LABEL[d.lifecycle_status] || d.lifecycle_status), esc(fmtBytes(d.size_bytes)),
    ]), { numeric: [4] }) || '<p class="empty">None.</p>'}
  </section>
  <section aria-labelledby="jobs-h">
    <h2 id="jobs-h">Recent jobs</h2>
    ${table('Jobs on this object, newest first', ['Job', 'Status', 'Error', 'Attempts', 'Created', 'Finished'], obj.jobs.map(j => [
        esc(j.type), esc(j.status), esc(j.error_code || ''), `${num(j.attempts)} of ${num(j.max_attempts)}`, esc(fmtWhen(j.created_at)), esc(fmtWhen(j.finished_at)),
    ])) || '<p class="empty">None.</p>'}
  </section>
  <p class="note">Read-only: visibility, deletion and restore are changed in the app that stored this object.</p>`;
    return doc({ title: name, description: 'One of your media objects on OpenVibe.Media.', body, script: !!obj.upload });
}

// ── Operator views (/me/ops) ─────────────────────────────────

function renderOps({ person, report, canRecompute, recomputed = null }) {
    const r = report;
    const opt = (v, label) => `<option value="${esc(v)}"${(r.scope === 'all' ? '' : r.scope) === v ? ' selected' : ''}>${esc(label)}</option>`;
    const scopeQs = r.scope === 'all' ? '' : `?app=${encodeURIComponent(r.scope)}`;
    const card = (value, label) => `<div class="card"><b>${value}</b><span>${esc(label)}</span></div>`;
    const kv = (obj) => Object.entries(obj || {}).map(([k, v]) => `${esc(k.replace(/_/g, ' '))} ${num(v)}`).join(' · ') || 'none';
    const t = r.tiering;
    const no = t.native_objects || null;
    const bf = r.backfill;
    const m = r.missing;
    const body = `
  <h1>Media operations</h1>
  <p class="meta"><span>Signed in as <strong>${esc(person.username ? `@${person.username}` : person.subject)}</strong></span><span aria-hidden="true">·</span><span>generated ${esc(fmtWhen(r.generated_at))}</span></p>
  <form class="filters" method="get" action="/me/ops" aria-label="Scope">
    <div><label for="ops-app">Tenant</label><select id="ops-app" name="app">${opt('', 'All tenants')}${r.tenants.map(a => opt(a, a)).join('')}</select></div>
    <div class="go"><button type="submit" class="btn">Show</button></div>
  </form>
  ${recomputed ? `<p class="note" role="status">Usage recomputed for ${num(recomputed)} namespace${recomputed === '1' ? '' : 's'}.</p>` : ''}
  <div class="cols">
    ${card(num(r.jobs.failed.total), 'failed jobs')}
    ${card(num(m.no_good_copy.total), 'ready objects with no good copy')}
    ${card(num(m.locations.missing_or_corrupt.length), 'missing or corrupt copies listed')}
    ${card(num(Object.values(bf.unprojected).reduce((a, b) => a + b, 0)), 'rows without an object')}
    ${card(num(t.pending_offload), 'VODs eligible to offload')}
  </div>

  <section aria-labelledby="jobs-h">
    <h2 id="jobs-h">Failed jobs</h2>
    <p class="hint">Jobs by status: ${kv(r.jobs.by_status)}.</p>
    <h3>Last 7 days by type and error</h3>
    ${table('Failed jobs in the last 7 days', ['Type', 'Error code', 'Jobs'], r.jobs.failed.last_7_days.map(x => [esc(x.type), esc(x.error_code || 'none'), num(x.count)]), { numeric: [2] }) || '<p class="empty">None.</p>'}
    <h3>Most recent</h3>
    ${table('Most recent failed jobs', ['Finished', 'Tenant', 'Job', 'Error', 'Attempts', 'Object'], r.jobs.failed.recent.map(j => [
        esc(fmtWhen(j.finished_at)), esc(j.app_id), `${esc(j.type)}<span class="id">${esc(j.id)}</span>`,
        `${j.error_code ? `<code>${esc(j.error_code)}</code>` : ''}${j.error ? `<pre class="err">${esc(j.error)}</pre>` : ''}`,
        `${num(j.attempts)} of ${num(j.max_attempts)}`, j.object_id ? `<code class="id">${esc(j.object_id)}</code>` : '',
    ])) || '<p class="empty">None.</p>'}
  </section>

  <section aria-labelledby="usage-h">
    <h2 id="usage-h">Usage</h2>
    <p class="hint">The namespaces' usage snapshot (refreshed at complete, delete and restore, when read, and hourly). Checks always count from the rows.</p>
    ${canRecompute ? `<form method="post" action="/me/ops/recompute${scopeQs}"><button type="submit" class="btn">Recompute usage${r.scope === 'all' ? '' : ` of ${esc(r.scope)}`} now</button></form>` : '<p class="hint">Recomputing needs the staff capability <code>staff.site.configure</code>.</p>'}
    ${table('Namespaces', ['Tenant', 'Namespace', 'Quota', 'Used', 'Reserved', 'Snapshot'], r.namespaces.map(n => [
        esc(n.app_id), esc(n.namespace),
        `${n.quota.bytes ? esc(fmtBytes(n.quota.bytes)) : 'no byte limit'}${n.quota.objects ? ` · ${num(n.quota.objects)} objects` : ''}`,
        `${esc(fmtBytes(n.usage.used_bytes))} · ${num(n.usage.used_objects)}`, `${esc(fmtBytes(n.usage.reserved_bytes))} · ${num(n.usage.reserved_objects)}`,
        esc(fmtWhen(n.usage.reconciled_at) || 'never'),
    ])) || '<p class="empty">No namespaces.</p>'}
  </section>

  <section aria-labelledby="missing-h">
    <h2 id="missing-h">Missing media</h2>
    <p class="hint">${esc(m.note)}</p>
    <p>Quarantined VODs: ${kv(m.vods_quarantined)}. Verification: ${kv(m.verification.statuses)}${m.verification.last_run ? `; last run ${esc(fmtWhen(m.verification.last_run.finished_at))}, ${num(m.verification.last_run.objects_checked)} checked, ${num(m.verification.last_run.no_good_copy)} with no good copy` : '; no run yet'}.</p>
    <h3>No good copy</h3>
    ${table('Ready objects with no good copy', ['Object', 'Tenant', 'Kind', 'Size', 'Last verification'], m.no_good_copy.objects.map(o => [
        `<code class="id">${esc(o.id)}</code>${o.legacy_ref ? `<span class="sub">${esc(o.legacy_ref)}</span>` : ''}`, esc(o.app_id), esc(o.kind), esc(fmtBytes(o.size_bytes)),
        o.last_verification ? `${esc(o.last_verification.status)} ${esc(fmtWhen(o.last_verification.at))}` : 'never',
    ]), { numeric: [3] }) || '<p class="empty">None.</p>'}
    <h3>Missing or corrupt copies</h3>
    ${table('Copies recorded missing or corrupt', ['Object', 'Tenant', 'Kind', 'Provider', 'State', 'Checked'], m.locations.missing_or_corrupt.map(l => [
        `<code class="id">${esc(l.object_id)}</code>${l.legacy_ref ? `<span class="sub">${esc(l.legacy_ref)}</span>` : ''}`, esc(l.app_id), esc(l.kind), esc(l.provider), esc(l.state), esc(fmtWhen(l.verified_at)),
    ])) || '<p class="empty">None.</p>'}
    <h3>Copies by provider and state</h3>
    ${table('Copies by provider and state', ['Provider', 'State', 'Copies'], m.locations.by_provider_state.map(x => [esc(x.provider), esc(x.state), num(x.count)]), { numeric: [2] }) || '<p class="empty">None.</p>'}
  </section>

  <section aria-labelledby="backfill-h">
    <h2 id="backfill-h">Backfill</h2>
    <p class="hint">${esc(bf.note)}</p>
    <dl class="facts">
      <dt>Last object backfill</dt><dd>${bf.objects ? `${esc(fmtWhen(bf.objects.finished_at))}${bf.objects.dry_run ? ' (dry run)' : ''}: ${bf.objects.totals ? kv(bf.objects.totals) : 'no totals'}; ${num(bf.objects.errors)} errors, ${num(bf.objects.skipped)} skipped` : 'none recorded'}</dd>
      <dt>Rows without an object</dt><dd>${kv(bf.unprojected)}</dd>
      <dt>Owner subject unresolved</dt><dd>${num(bf.owner_subject.missing)}${bf.owner_subject.by_app.length ? ` (${bf.owner_subject.by_app.map(a => `${esc(a.app_id)} ${num(a.count)}`).join(', ')})` : ''}</dd>
      <dt>Upload reservations seeded</dt><dd>${bf.namespace_reservations_seeded ? 'yes' : 'no'}</dd>
    </dl>
  </section>

  <section aria-labelledby="tiering-h">
    <h2 id="tiering-h">Tiering</h2>
    <p class="hint">${esc(t.note)}</p>
    <dl class="facts">
      <dt>Providers</dt><dd>B2 ${t.providers.b2 ? 'configured' : 'not configured'} · R2 ${t.providers.r2 ? 'configured' : 'not configured'}</dd>
      <dt>Policy</dt><dd>offload ${t.policy.enabled ? 'on' : 'off'} (age ${esc(t.policy.min_age_days)} d, at most ${esc(t.policy.max_views_for_cold)} views, idle ${esc(t.policy.min_last_access_days)} d) · R2 ${t.policy.r2_enabled ? 'on' : 'off'}</dd>
      <dt>Sweep</dt><dd>${t.sweep.running ? 'running' : 'idle'}${t.sweep.stalled ? ` · <strong>stalled</strong> (${num(t.sweep.stalled_passes)} passes)` : ''}; last ${esc(fmtWhen(t.sweep.last_run_at) || 'not in this process')}${t.sweep.next_run_at ? `; next ${esc(fmtWhen(t.sweep.next_run_at))}` : ''}${t.sweep.last_result ? `; moved ${num(t.sweep.last_result.migrated)} to B2, ${num(t.sweep.last_result.promoted)} to R2, ${num(t.sweep.last_result.demoted)} back, ${num(t.sweep.last_result.errors)} errors` : ''}</dd>
      <dt>Eligible to offload</dt><dd>${num(t.pending_offload)} VODs</dd>
      <dt>R2 decisions, 24 h</dt><dd>promote: ${kv(t.decisions_24h.promote)} · demote: ${kv(t.decisions_24h.demote)}</dd>
    </dl>
    ${table('VODs by provider', ['Provider', 'VODs', 'Bytes'], Object.entries(t.vods).map(([p, v]) => [esc(p), num(v.count), esc(fmtBytes(v.bytes))]), { numeric: [1, 2] })}
    ${table('Objects by canonical copy', ['Origin', 'Canonical copy', 'Objects', 'Bytes'], t.objects.map(o => [esc(o.origin), esc(o.canonical_provider), num(o.count), esc(fmtBytes(o.bytes))]), { numeric: [2, 3] })}
    <h3>Recent refused or failed moves</h3>
    ${table('Recent refused or failed tier moves', ['When', 'Tenant', 'VOD', 'Move', 'Outcome', 'Why'], t.recent_problems.map(d => [
        esc(fmtWhen(d.decided_at)), esc(d.app_id || ''), esc(d.vod_id), `${esc(d.action)} ${esc(d.from_provider || '')} → ${esc(d.to_provider || '')}`, esc(d.outcome), esc(d.error || d.reason || ''),
    ])) || '<p class="empty">None.</p>'}
    ${no ? `<h3>Native objects</h3>
    <dl class="facts">
      <dt>Activation gate</dt><dd>${no.gate.active ? '<strong>on</strong>: the sweep moves objects' : 'off: dry runs only'} (${esc(no.gate.source)})</dd>
      <dt>Policy</dt><dd>promote at ${num(no.policy.promoteMinUniqueViewers7d)} unique viewers in 7 days, viewed within ${esc(no.policy.promoteRecentAccessDays)} d, ${esc(no.policy.promoteMinSizeMb)} to ${esc(no.policy.promoteMaxSizeMb)} MB · demote after ${esc(no.policy.demoteIdleDays)} idle days</dd>
      <dt>In R2</dt><dd>${num(no.r2_copies.count)} objects, ${esc(fmtBytes(no.r2_copies.bytes))} · eligible to promote now: ${num(no.eligible_to_promote)}</dd>
      <dt>Decisions, 24 h</dt><dd>promote: ${kv(no.decisions_24h.promote)} · demote: ${kv(no.decisions_24h.demote)}</dd>
    </dl>
    ${table('Recent native object tier decisions', ['When', 'Tenant', 'Object', 'Action', 'Outcome', 'Why'], no.recent.map(d => [
        esc(fmtWhen(d.decided_at)), esc(d.app_id || ''), `<code class="id">${esc(d.object_id)}</code>`, esc(d.action), esc(d.outcome.replace('_', ' ')), esc(d.error || d.reason || ''),
    ])) || '<p class="empty">None.</p>'}` : ''}
  </section>
  <p class="hint">JSON: <a href="/api/v2/me/ops${scopeQs}">/api/v2/me/ops</a>.</p>`;
    return doc({ title: 'Media operations', description: 'Operator views of OpenVibe.Media: failed jobs, usage, missing media, backfill and tiering.', body });
}

module.exports = {
    renderSignIn, renderForbidden, renderDrill, renderExplorer, renderDetail, renderOps,
    fmtBytes, fmtWhen, displayName, CLIENT_SOURCE, CLIENT_VERSION,
};

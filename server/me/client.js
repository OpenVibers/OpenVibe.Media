/*
 * OpenVibe.Media — /me/app.js: progressive enhancement for the object explorer (server/me/pages.js).
 * Runs in the browser. The pages work without it; with it:
 *   - the filter form and "Next page" load from /api/v2/me/objects without a reload ("Load more" appends);
 *   - uploads in progress are polled (every 4 s while the tab is visible, backing off on errors) and
 *     their progress bars updated; a row whose upload finished is replaced with its new state.
 * Every string from the API goes into the page as text (textContent), never as markup.
 */
(function () {
    'use strict';

    var KIND = { vod: 'VOD', clip: 'Clip', file: 'File', thumbnail: 'Thumbnail', screenshot: 'Screenshot', avatar: 'Avatar', asset: 'Asset' };
    var STATUS = { uploading: 'Uploading', ready: 'Ready', failed: 'Failed', archived: 'Archived', deleted: 'Deleted' };
    var REASON = { no_object: 'no object', deleted: 'deleted', metadata_unreadable: 'metadata unreadable', failed: 'failed', archived: 'archived',
        recording: 'still recording', processing: 'still processing', verification_pending: 'copy not checked yet', no_verified_copy: 'no verified copy' };
    var POLL_MS = 4000;

    function fmtBytes(n) {
        n = Number(n) || 0;
        if (n < 1024) return n + ' B';
        var units = ['KB', 'MB', 'GB', 'TB'], v = n, i = -1;
        do { v /= 1024; i++; } while (v >= 1024 && i < units.length - 1);
        return (v >= 100 ? Math.round(v) : v.toFixed(1)) + ' ' + units[i];
    }
    function fmtWhen(iso) {
        if (!iso) return '';
        var d = new Date(iso);
        return isNaN(d.getTime()) ? '' : d.toISOString().slice(0, 16).replace('T', ' ') + ' UTC';
    }
    function num(n) { return Number(n || 0).toLocaleString('en-US'); }
    function displayName(it) { return it.title || it.filename || ((KIND[it.kind] || it.kind) + ' ' + it.id.slice(-6)); }

    /** el('a', { href: '/x', className: 'c' }, ['text', node]) */
    function el(tag, attrs, children) {
        var node = document.createElement(tag);
        Object.keys(attrs || {}).forEach(function (k) {
            var v = attrs[k];
            if (v == null || v === false) return;
            if (k === 'className') node.className = v;
            else if (k === 'text') node.textContent = v;
            else node.setAttribute(k, v === true ? '' : String(v));
        });
        (children || []).forEach(function (c) { if (c != null) node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c); });
        return node;
    }
    function tag(cls, text) { return el('span', { className: 'tag ' + cls, text: text }); }
    function sub(text) { return el('span', { className: 'sub', text: text }); }

    function uploadWords(u) {
        if (u.waiting_for === 'complete') return 'all bytes stored, waiting for the app to complete it';
        if (u.waiting_for === 'assembly') return 'assembling the parts';
        return (u.percent != null ? u.percent + '% · ' : '') + fmtBytes(u.received_bytes)
            + (u.declared_bytes ? ' of ' + fmtBytes(u.declared_bytes) : ' received')
            + (u.method === 'multipart' ? ' · ' + u.parts_received + ' of ' + u.parts_expected + ' parts' : '');
    }

    function uploadBox(it) {
        var u = it.upload;
        var bar = el('progress', { 'aria-label': 'Upload of ' + displayName(it) });
        if (u.percent != null) { bar.max = 100; bar.value = u.percent; bar.textContent = u.percent + '%'; }
        var box = el('div', { className: 'up', 'data-upload': it.id }, [bar, el('span', { className: 'sub up-text', text: uploadWords(u) })]);
        if (u.expires_at) box.appendChild(sub('unfinished uploads fail after ' + fmtWhen(u.expires_at)));
        return box;
    }

    function statusNodes(it) {
        var out = [el('span', { className: 'st', text: STATUS[it.lifecycle_status] || it.lifecycle_status })];
        if (it.upload) out.push(' ', uploadBox(it));
        if (it.failure) out.push(' ', sub(it.failure.replace(/_/g, ' ')));
        if (it.deleted) out.push(' ', sub(it.deleted.purged ? 'bytes purged' : it.deleted.retention_until ? 'kept until ' + fmtWhen(it.deleted.retention_until) : 'kept for the retention period'));
        if (it.held) out.push(' ', tag('warn', 'Held'));
        return out;
    }

    function readinessNodes(it) {
        var r = it.readiness || {};
        var out = [r.metadata ? tag('ok', 'metadata') : tag('no', 'no metadata'), r.bytes_verified ? tag('ok', 'bytes verified') : tag('no', 'bytes not verified')];
        if (it.kind === 'vod' || it.kind === 'clip') out.push(r.playable ? tag('ok', 'playable') : tag('no', 'not playable' + (r.reason && REASON[r.reason] ? ': ' + REASON[r.reason] : '')));
        return out;
    }

    function cell(label, children, cls) { return el('td', { 'data-label': label, className: cls }, [el('span', {}, children)]); }

    function buildRow(it) {
        var name = displayName(it);
        var tenant = [it.tenant.name];
        if (it.tenant.sandbox) tenant.push(' ', el('span', { className: 'tag', text: 'sandbox' }));
        tenant.push(sub(it.namespace));
        var vis = [it.visibility];
        if (it.public_url) vis.push(' ', el('a', { href: it.public_url }, ['open', el('span', { className: 'sr', text: ' ' + name })]));
        var head = el('th', { scope: 'row', 'data-label': 'Name' }, [el('span', {}, [
            el('a', { href: '/me/objects/' + encodeURIComponent(it.id), text: name }),
            el('span', { className: 'id', text: it.id }),
            it.mime_type ? sub(it.mime_type) : null,
        ])]);
        var tr = el('tr', { 'data-id': it.id, 'data-status': it.lifecycle_status, 'data-uploading': it.upload ? '1' : null }, [
            head,
            el('td', { 'data-label': 'Kind', text: KIND[it.kind] || it.kind }),
            cell('Tenant', tenant),
            el('td', { 'data-label': 'Size', className: 'n', text: fmtBytes(it.size_bytes) }),
            cell('Visibility', vis),
            cell('Status', statusNodes(it)),
            cell('Readiness', readinessNodes(it)),
            el('td', { 'data-label': 'Derivatives', className: 'n', text: num(it.derivatives) }),
            cell('Created', [fmtWhen(it.created_at)]),
        ]);
        return tr;
    }

    function fetchJson(url) {
        return fetch(url, { credentials: 'same-origin', headers: { Accept: 'application/json' } }).then(function (res) {
            return res.json().catch(function () { return {}; }).then(function (body) {
                if (!res.ok) { var err = new Error(body.detail || body.error || ('HTTP ' + res.status)); err.status = res.status; throw err; }
                return body;
            });
        });
    }

    var live = document.getElementById('me-status');
    function announce(text) { if (live) live.textContent = text; }

    // ── Upload progress (the list, or one object's page) ─────
    var pollTimer = null, pollDelay = POLL_MS;
    var table = document.getElementById('me-objects');

    function uploadingIds() {
        var nodes = document.querySelectorAll(table ? 'tr[data-uploading]' : '[data-upload]');
        return Array.prototype.map.call(nodes, function (n) { return n.getAttribute(table ? 'data-id' : 'data-upload'); });
    }

    function schedulePoll() {
        if (pollTimer || !uploadingIds().length) return;
        pollTimer = setTimeout(poll, pollDelay);
    }

    function onVisible() { if (!document.hidden) { document.removeEventListener('visibilitychange', onVisible); schedulePoll(); } }

    function updateRow(tr, it) {
        if (it.upload && it.lifecycle_status === 'uploading') {
            var box = tr.querySelector('[data-upload]');
            if (box) { box.parentNode.replaceChild(uploadBox(it), box); return; }
        }
        var hadFocus = tr.contains(document.activeElement);
        var fresh = buildRow(it);
        tr.parentNode.replaceChild(fresh, tr);
        if (hadFocus) fresh.querySelector('a').focus();
        if (!it.upload) announce(displayName(it) + ': ' + (STATUS[it.lifecycle_status] || it.lifecycle_status) + '.');
    }

    function poll() {
        pollTimer = null;
        if (document.hidden) { document.addEventListener('visibilitychange', onVisible); return; }
        var ids = uploadingIds();
        if (!ids.length) return;
        if (!table) {
            // One object's page: follow it; when it stops uploading, show its new state.
            fetchJson('/api/v2/me/objects/' + encodeURIComponent(ids[0])).then(function (it) {
                if (it.lifecycle_status !== 'uploading') { window.location.reload(); return; }
                var box = document.querySelector('[data-upload]');
                if (box && it.upload) box.parentNode.replaceChild(uploadBox(it), box);
                pollDelay = POLL_MS; schedulePoll();
            }).catch(failed);
            return;
        }
        fetchJson('/api/v2/me/objects?status=uploading&limit=100').then(function (data) {
            var byId = {};
            (data.objects || []).forEach(function (o) { byId[o.id] = o; });
            var pending = ids.map(function (id) {
                var tr = table.querySelector('tr[data-id="' + id + '"]');
                if (!tr) return null;
                if (byId[id]) { updateRow(tr, byId[id]); return null; }
                return fetchJson('/api/v2/me/objects/' + encodeURIComponent(id)).then(function (it) { updateRow(tr, it); })
                    .catch(function () { tr.removeAttribute('data-uploading'); });
            });
            return Promise.all(pending);
        }).then(function () { pollDelay = POLL_MS; schedulePoll(); }).catch(failed);
    }

    function failed(err) {
        if (err && err.status === 401) { announce('You are signed out: upload progress stopped. Reload the page after signing in.'); return; }
        pollDelay = Math.min(pollDelay * 2, 60000);
        schedulePoll();
    }

    // ── Filters and pages (/me) ──────────────────────────────
    var form = document.getElementById('me-filters');
    var next = document.getElementById('me-next');
    var empty = document.getElementById('me-empty');

    function filterQuery() {
        var p = new URLSearchParams();
        new FormData(form).forEach(function (v, k) { if (String(v).trim()) p.set(k, String(v).trim()); });
        return p;
    }

    function load(append) {
        var p = filterQuery();
        var cursor = append && next ? next.getAttribute('data-cursor') : null;
        if (cursor) p.set('cursor', cursor);
        announce('Loading…');
        return fetchJson('/api/v2/me/objects?' + p.toString()).then(function (data) {
            var body = table.tBodies[0];
            if (!append) while (body.firstChild) body.removeChild(body.firstChild);
            var first = null;
            (data.objects || []).forEach(function (it) { var tr = buildRow(it); if (!first) first = tr; body.appendChild(tr); });
            var shown = body.rows.length;
            table.hidden = !shown;
            if (empty) { empty.hidden = !!shown; empty.textContent = p.toString().replace(/(^|&)cursor=[^&]*/, '') ? 'No objects match these filters.' : 'No objects yet.'; }
            if (next) {
                var q = new URLSearchParams(p.toString()); q.delete('cursor');
                if (data.next_cursor) {
                    q.set('cursor', data.next_cursor);
                    next.href = '/me?' + q.toString();
                    next.setAttribute('data-cursor', data.next_cursor);
                    next.textContent = 'Load more';
                    next.hidden = false;
                } else {
                    next.hidden = true;
                    next.removeAttribute('data-cursor');
                }
            }
            if (!append) {
                var clean = filterQuery().toString();
                try { history.replaceState(null, '', '/me' + (clean ? '?' + clean : '')); } catch (e) { /* not allowed here */ }
            }
            announce(num(shown) + ' object' + (shown === 1 ? '' : 's') + ' shown' + (data.next_cursor ? ', more available' : '') + '.');
            if (append && first) first.querySelector('a').focus();
            schedulePoll();
        }).catch(function (err) {
            announce(err.status === 401 ? 'You are signed out. Reload the page after signing in.' : 'Could not load your objects: ' + err.message);
        });
    }

    if (form && table) {
        form.addEventListener('submit', function (e) { e.preventDefault(); load(false); });
        if (next) {
            var m = /[?&]cursor=([^&]+)/.exec(next.getAttribute('href') || '');
            if (m && !next.hidden) { next.setAttribute('data-cursor', decodeURIComponent(m[1])); next.textContent = 'Load more'; }
            next.addEventListener('click', function (e) {
                if (!next.getAttribute('data-cursor')) return;
                e.preventDefault();
                load(true);
            });
        }
    }
    schedulePoll();
})();

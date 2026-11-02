'use strict';
/**
 * The site's own 404 page (server/public/not-found-page.js): a browser that asks for a page that does not exist
 * — a missing, private or unread recording or clip — gets this page instead of a raw JSON answer, in the same
 * frame and look as every other page of the site.
 *
 * The page says nothing about what was asked for: a private item and a missing one must look the same, so no
 * id, no path and no title appear here. Only the answer is the same, never what was asked.
 */
const config = require('../config');
const pageFrame = require('./page-frame');

const { esc, SITE_NAME } = pageFrame;

function renderNotFound() {
    return pageFrame.page({
        seo: {
            title: `Not found — ${SITE_NAME}`,
            description: 'This page does not exist, or the recording or clip behind it is not public.',
            // A page that does not exist is never indexed; the site's own pages stay reachable.
            robots: 'noindex, follow',
            ogType: 'website',
        },
        body: `
  <h1>Not found</h1>
  <p class="note">This page does not exist, or the recording or clip behind it is not public. It looks the same either way: nothing here says which.</p>
  <div class="actions">
    <a class="btn" href="${esc(config.publicUrl)}/">Browse everything on Media</a>
    <a class="btn ghost" href="${esc(config.publicUrl)}/?tab=videos">Videos</a>
    <a class="btn ghost" href="${esc(config.publicUrl)}/?tab=clips">Clips</a>
  </div>`,
        footer: { variant: 'compact' },
    });
}

module.exports = { renderNotFound };

/**
 * Outcomes are announced as OpenVibe.Events events written in the state change's own
 * transaction. Per-app webhooks are gone (C-75).
 */
'use strict';

const db = require('./db/database');

/**
 * Commit an outcome and announce it. `change()` (synchronous DB writes, optional) and the outbox
 * row for `event` run in ONE PostgreSQL transaction, so the durable event exists if and only if the
 * change committed: never lost after a commit, never announced for a rollback. `payload()` is read
 * inside that transaction (the row as committed). After the commit the relay is woken.
 * Returns { data, eventId }; throws (nothing changed, nothing queued) when the transaction fails.
 */
async function announce(appId, event, { change = null, payload }) {
    const events = require('./events');
    let data = null;
    let env = null;
    await db.getDb().tx(async () => {
        if (change) await change();
        data = typeof payload === 'function' ? await payload() : payload;
        env = await events.record(event, appId, data);
        await events.recordObjectChanges();       // a row the change deleted: media.object.deleted, same transaction
    });
    events.kick();
    const eventId = env ? env.event_id : null;
    return { data, eventId };
}

module.exports = { announce };

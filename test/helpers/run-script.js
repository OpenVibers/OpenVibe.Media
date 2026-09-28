'use strict';
/**
 * Runs an operator script (scripts/*.js) inside this test process, on this process's database (a test database is
 * PGlite in the process: a child process could not reach it). argv is set, stdout/stderr are captured, and
 * process.exit is intercepted: → { code, out, err }. Module state stays as the script left it, as in a real run.
 */
const path = require('path');

class ScriptExit extends Error { constructor(code) { super(`exit ${code}`); this.code = code; } }

async function runScript(file, args = [], { env = {} } = {}) {
    const saved = { argv: process.argv, exit: process.exit, log: console.log, error: console.error, warn: console.warn, write: process.stdout.write, ewrite: process.stderr.write, env: { ...process.env } };
    let out = ''; let err = ''; let code = null; let resolve;
    const finished = new Promise((r) => { resolve = r; });
    const swallow = (reason) => { if (!(reason instanceof ScriptExit)) { err += `${(reason && reason.stack) || reason}\n`; if (code === null) { code = 1; resolve(); } } };
    process.on('unhandledRejection', swallow);
    process.argv = [saved.argv[0], path.resolve(file), ...args];
    Object.assign(process.env, env);
    console.log = (...a) => { out += `${a.join(' ')}\n`; };
    console.error = console.warn = (...a) => { if (a.some((x) => x instanceof ScriptExit)) return; err += `${a.join(' ')}\n`; };   // not the script's .catch of our exit
    process.stdout.write = (c) => { out += c; return true; };
    process.stderr.write = (c) => { err += c; return true; };
    process.exit = (c = 0) => { if (code === null) { code = c; resolve(); } throw new ScriptExit(c); };
    const mainBefore = process.mainModule;
    try {
        delete require.cache[require.resolve(path.resolve(file))];
        // As the main module, so a script's `require.main === module` CLI part runs.
        require('module')._load(path.resolve(file), null, true);
    } catch (e) { if (!(e instanceof ScriptExit)) { err += `${e.stack}\n`; if (code === null) { code = 1; resolve(); } } }
    await finished;
    await new Promise((r) => setImmediate(r));   // the script's own .catch after the intercepted exit
    process.mainModule = mainBefore;
    process.argv = saved.argv; process.exit = saved.exit;
    console.log = saved.log; console.error = saved.error; console.warn = saved.warn;
    process.stdout.write = saved.write; process.stderr.write = saved.ewrite;
    for (const k of Object.keys(process.env)) if (!(k in saved.env)) delete process.env[k];
    Object.assign(process.env, saved.env);
    process.off('unhandledRejection', swallow);
    return { code, out, err };
}

module.exports = { runScript };

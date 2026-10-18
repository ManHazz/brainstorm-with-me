#!/usr/bin/env node
'use strict';
// brainstorm-with-me CLI. JSON on stdout, progress on stderr.

const HELP = `usage: node scripts/bwm.js <command> [--flag value ...]

board:
  open [--project p] [--no-open]           start the board server and open the page
  draw --project p --spec <file.json|.mmd> merge a spec into the board
  await --project p [--reply text] [--timeout-ms n]
                                           wait for the user's next board input
  pending [--hook]                         list undelivered board input (Stop hook mode with --hook)
  unlock --project p --id x                let Claude change an item again
  stop                                     stop the board server
  server                                   run the server in the foreground

vault: init, brief, decide, question, resolve, reject, critique-save, wrap,
       pickup, export, status, config (see docs/CONTRACTS.md)
`;

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--') && a.length > 2) {
      const eq = a.indexOf('=');
      if (eq > 2) { args[a.slice(2, eq)] = a.slice(eq + 1); continue; }
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) { args[key] = next; i++; }
      else args[key] = true;
    } else {
      args._.push(a);
    }
  }
  return args;
}

function loadCommands() {
  const all = {};
  try {
    Object.assign(all, require('./lib/cli-vault').commands);
  } catch (err) {
    // only "cli-vault.js itself is missing" is fine; a broken dependency inside it is a real error
    const direct = err.code === 'MODULE_NOT_FOUND'
      && String(err.message).includes(`'./lib/cli-vault'`)
      && Array.isArray(err.requireStack) && err.requireStack[0] === __filename;
    if (!direct) throw err;
  }
  Object.assign(all, require('./lib/cli-board').commands);
  return all;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = args._.shift();
  if (!cmd || cmd === 'help' || args.help) {
    process.stdout.write(HELP);
    return;
  }
  const commands = loadCommands();
  const fn = commands[cmd];
  if (!fn) {
    process.stderr.write(`unknown command: ${cmd}\n${HELP}`);
    process.exitCode = 1;
    return;
  }
  try {
    const result = await fn(args);
    if (result !== undefined) process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  } catch (err) {
    const out = { error: err.message };
    if (err.details) out.errors = err.details;
    if (err.warnings) out.warnings = err.warnings;
    process.stdout.write(JSON.stringify(out, null, 2) + '\n');
    process.exitCode = 1;
  }
}

if (require.main === module) main();
module.exports = { parseArgs };

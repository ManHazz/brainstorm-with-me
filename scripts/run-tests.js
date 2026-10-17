#!/usr/bin/env node
'use strict';

// Runs every tests/*.test.js with node --test. Node 20 has no glob support in
// --test, so we list the files ourselves.

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const dir = path.join(__dirname, '..', 'tests');
const files = fs.readdirSync(dir)
  .filter((f) => f.endsWith('.test.js'))
  .sort()
  .map((f) => path.join(dir, f));

const r = spawnSync(process.execPath, ['--test', ...files, ...process.argv.slice(2)], { stdio: 'inherit' });
process.exitCode = r.status === null ? 1 : r.status;

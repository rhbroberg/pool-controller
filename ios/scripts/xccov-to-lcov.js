#!/usr/bin/env node
'use strict';
// Converts the coverage in an Xcode result bundle to lcov, which Cursor's Coverage Gutters
// extension shows in the editor.
//
//   node scripts/xccov-to-lcov.js build/TestResults.xcresult coverage/lcov.info
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const [resultBundle, output] = process.argv.slice(2);
if (!resultBundle || !output) {
    console.error('usage: xccov-to-lcov.js <result.xcresult> <lcov.info>');
    process.exit(2);
}

const xccov = (...args) => JSON.parse(execFileSync('xcrun', ['xccov', 'view', ...args, '--json', resultBundle],
    { maxBuffer: 256 * 1024 * 1024 }));

// per line: { line, isExecutable, executionCount }
const lines = xccov('--archive');
// per target and file: functions with their first line and execution count
const report = xccov('--report');

const functionsByFile = new Map();
for (const target of report.targets) {
    for (const file of target.files) {
        functionsByFile.set(file.path, file.functions || []);
    }
}

const records = [];
let found = 0;
let hit = 0;
for (const [file, entries] of Object.entries(lines).sort(([a], [b]) => a.localeCompare(b))) {
    const executable = entries.filter((entry) => entry.isExecutable);
    const record = [`SF:${file}`];
    const functions = functionsByFile.get(file) || [];
    functions.forEach((fn, index) => {
        // names repeat (several closures in one function), but lcov keys functions by name
        record.push(`FN:${fn.lineNumber},${index}:${fn.name}`);
    });
    functions.forEach((fn, index) => {
        record.push(`FNDA:${fn.executionCount},${index}:${fn.name}`);
    });
    record.push(`FNF:${functions.length}`, `FNH:${functions.filter((fn) => fn.executionCount > 0).length}`);
    for (const entry of executable) {
        record.push(`DA:${entry.line},${entry.executionCount || 0}`);
    }
    const covered = executable.filter((entry) => entry.executionCount > 0).length;
    record.push(`LF:${executable.length}`, `LH:${covered}`, 'end_of_record');
    records.push(record.join('\n'));
    found += executable.length;
    hit += covered;
}

fs.mkdirSync(path.dirname(output), { recursive: true });
fs.writeFileSync(output, records.join('\n') + '\n');
console.log(`wrote ${output}: ${hit} of ${found} lines covered (${found ? (100 * hit / found).toFixed(1) : 0}%) in ${records.length} files`);

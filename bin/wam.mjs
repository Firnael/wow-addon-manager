#!/usr/bin/env node
// Entry point: checks the Node version before anything else is loaded (static imports
// would run first), so an old Node stops with a clear message instead of a stack trace.

const MIN = 24;
const major = Number(process.versions.node.split('.')[0]);
if (major < MIN) {
  console.error(`wam : Node ${MIN} ou plus requis (actuel : ${process.version}). Installer Node ${MIN} depuis https://nodejs.org, puis relancer.`);
  process.exit(1);
}

await import('../src/cli.mjs');

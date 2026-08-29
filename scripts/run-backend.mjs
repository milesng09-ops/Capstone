#!/usr/bin/env node
/**
 * Start the backend with the virtual environment's own interpreter.
 *
 * `.claude/launch.json` can only name one executable, and the one thing that
 * differs between platforms here is exactly the path to that executable:
 * POSIX puts it in `.venv/bin/python`, Windows in `.venv\Scripts\python.exe`.
 * That single difference is the whole reason this file exists -- hard-coding
 * either path makes the launch configuration silently useless on the other
 * platform, in a project whose README goes out of its way to work on both.
 *
 * Node is a safe host for the shim: the frontend already needs it, so anyone
 * who can run one half of this application can run the other.
 *
 * Extra arguments are forwarded to uvicorn, so `--reload` or a different
 * `--log-level` can be added to `runtimeArgs` without touching this file.
 */

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const backend = join(root, 'backend')
const venv = join(backend, '.venv')

/*
 * Probe the disk rather than branching on `process.platform`.
 *
 * The layout is a property of the virtual environment, not of the machine
 * reading it, and the two can disagree: a POSIX-style venv can turn up on
 * Windows under WSL or a mounted volume. Asking which interpreter is actually
 * there answers the real question and costs two stat calls.
 */
const interpreter = [
  join(venv, 'bin', 'python'),
  join(venv, 'Scripts', 'python.exe'),
].find(existsSync)

if (!interpreter) {
  console.error(
    `No virtual environment found at ${venv}\n\n` +
      'Create one first (see the README for the platform-specific form):\n' +
      '  macOS / Linux   cd backend && python3.12 -m venv .venv && ' +
      '.venv/bin/pip install -r requirements.txt\n' +
      '  Windows         cd backend; python -m venv .venv; ' +
      '.venv\\Scripts\\pip install -r requirements.txt',
  )
  process.exit(1)
}

// PORT is what the harness sets when it assigns a port itself; the literal is
// the default the launch configuration and the README both name.
const port = process.env.PORT ?? '8000'

const child = spawn(
  interpreter,
  [
    '-m',
    'uvicorn',
    'app.main:app',
    '--app-dir',
    backend,
    '--port',
    port,
    ...process.argv.slice(2),
  ],
  { stdio: 'inherit' },
)

child.on('error', (error) => {
  console.error(`Could not start ${interpreter}: ${error.message}`)
  process.exit(1)
})

// A signalled exit has no code; report it as a failure rather than as the
// clean zero that `code ?? 0` would produce.
child.on('exit', (code, signal) => {
  process.exit(signal ? 1 : (code ?? 0))
})

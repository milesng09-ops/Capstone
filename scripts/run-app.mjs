#!/usr/bin/env node
// One foreground command owns both servers, including shutdown and failures.
import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const backendPort = Number(process.env.PORT ?? 8000)
const children = []
let stopping = false

function stop(code = 0) {
  if (stopping) return
  stopping = true
  process.exitCode = code
  for (const child of children) child.kill('SIGTERM')
}
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => stop())

function start(args, env = process.env, cwd = root) {
  const child = spawn(process.execPath, args, { cwd, stdio: 'inherit', env })
  children.push(child)
  child.on('error', error => { console.error(error.message); stop(1) })
  child.on('exit', code => { if (!stopping) stop(code || 1) })
}

try {
  // Fail clearly instead of opening the UI against an unrelated app/server.
  for (const [port, host] of [[backendPort, '127.0.0.1'], [5173, 'localhost']]) {
    await new Promise((resolve, reject) => {
      const probe = createServer()
      probe.once('error', () => reject(new Error(`Port ${port} is unavailable. Stop the existing server, then rerun npm run dev.`)))
      probe.listen(port, host, () => probe.close(resolve))
    })
  }
  start(['scripts/run-backend.mjs'])
  let ready = false
  for (let attempt = 0; attempt < 60 && !stopping; attempt++) {
    try {
      const response = await fetch(`http://127.0.0.1:${backendPort}/api/health`, { signal: AbortSignal.timeout(1000) })
      const health = await response.json()
      if (response.ok && health.status === 'ok' && health.database === 'connected') { ready = true; break }
    } catch { /* Backend is still starting. */ }
    await new Promise(resolve => setTimeout(resolve, 500))
  }
  if (!stopping) {
    if (!ready) throw new Error('Backend did not become ready within 30 seconds. Check its log above.')
    start([resolve(root, 'frontend/node_modules/vite/bin/vite.js'), '--host', 'localhost', '--port', '5173', '--strictPort'], {
      ...process.env, VITE_API_PROXY_TARGET: `http://127.0.0.1:${backendPort}`,
    }, resolve(root, 'frontend'))
    console.log('Market Replay Lab: http://localhost:5173 (backend connected)')
  }
} catch (error) {
  console.error(error.message)
  stop(1)
}

#!/usr/bin/env node
// 集成测试入口：与领域测试同一套 TS 钩子，仅入口文件不同。
import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')

const child = spawn(
  process.execPath,
  ['--import', './tests/register-hooks.mjs', './tests/integration.test.ts'],
  { cwd: root, stdio: 'inherit' },
)
child.on('exit', (code) => process.exit(code ?? 1))

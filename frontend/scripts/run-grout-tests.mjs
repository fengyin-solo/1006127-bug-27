#!/usr/bin/env node
// 不依赖 esbuild 原生二进制：用 Node 钩子 + TypeScript 自带转译跑领域测试。
import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')

const child = spawn(
  process.execPath,
  ['--import', './tests/register-hooks.mjs', './tests/grout.test.ts'],
  { cwd: root, stdio: 'inherit' },
)
child.on('exit', (code) => process.exit(code ?? 1))

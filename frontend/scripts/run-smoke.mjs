// 用 esbuild 把冒烟脚本（含 @ 别名）打包成 cjs 后执行。
import { buildSync } from 'esbuild'
import { execFileSync } from 'node:child_process'
import { rmSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const outfile = fileURLToPath(new URL('./.smoke-regrout.bundle.cjs', import.meta.url))

buildSync({
  entryPoints: [fileURLToPath(new URL('./smoke-regrout.ts', import.meta.url))],
  outfile,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  alias: { '@': fileURLToPath(new URL('../src', import.meta.url)) },
  logLevel: 'silent',
})

try {
  execFileSync(process.execPath, [outfile], { stdio: 'inherit' })
} finally {
  rmSync(outfile, { force: true })
}

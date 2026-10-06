// Node ESM 定制钩子：让 Node 直接运行 TS 测试，并解析 '@/' 路径别名。
// 不依赖 esbuild 原生二进制（当前镜像只装了 darwin 版），只用 TypeScript 自带转译。
import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import path from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const ts = require('typescript')
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

export async function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith('@/')) {
    const candidate = path.join(root, 'src', specifier.slice(2))
    for (const ext of ['.ts', '.js', '.vue']) {
      if (existsSync(candidate + ext)) {
        if (ext === '.vue') break
        return { url: pathToFileURL(candidate + ext).href, shortCircuit: true }
      }
    }
    const indexTs = path.join(candidate, 'index.ts')
    if (existsSync(indexTs)) {
      return { url: pathToFileURL(indexTs).href, shortCircuit: true }
    }
  }
  if (specifier.endsWith('.ts') && !specifier.startsWith('node:') && !specifier.startsWith('file:')) {
    const base = context.parentURL ? fileURLToPath(context.parentURL) : path.join(root, specifier)
    const target = path.resolve(path.dirname(base), specifier)
    return { url: pathToFileURL(target).href, shortCircuit: true }
  }
  // 相对路径无扩展名的 TS 导入：补 .ts 或目录 index.ts。
  if (specifier.startsWith('.') || specifier.startsWith('/')) {
    const base = context.parentURL ? fileURLToPath(context.parentURL) : root
    const target = path.resolve(path.dirname(base), specifier)
    for (const ext of ['.ts', '.js']) {
      if (existsSync(target + ext)) return { url: pathToFileURL(target + ext).href, shortCircuit: true }
    }
    if (existsSync(path.join(target, 'index.ts'))) {
      return { url: pathToFileURL(path.join(target, 'index.ts')).href, shortCircuit: true }
    }
  }
  return nextResolve(specifier, context)
}

export async function load(url, context, nextLoad) {
  if (url.endsWith('.ts')) {
    const source = readFileSync(fileURLToPath(url), 'utf8')
    const { outputText } = ts.transpileModule(source, {
      compilerOptions: {
        module: ts.ModuleKind.ES2022,
        target: ts.ScriptTarget.ES2022,
        sourceMap: false,
        inlineSourceMap: true,
        inlineSources: true,
      },
      fileName: fileURLToPath(url),
    })
    return { format: 'module', source: outputText, shortCircuit: true }
  }
  return nextLoad(url, context)
}

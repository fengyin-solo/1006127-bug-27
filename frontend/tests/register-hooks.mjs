// 通过 --register 注册 tests/ts-hooks.mjs 里的 resolve/load 钩子。
import { register } from 'node:module'

register(new URL('./ts-hooks.mjs', import.meta.url))

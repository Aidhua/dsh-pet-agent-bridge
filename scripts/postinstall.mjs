#!/usr/bin/env node
/**
 * 安装后自动给 dsh-pet 打聊天入口补丁。
 *
 * 为什么需要它：桌面宠物窗口的输入走 dsh-pet 私有 IPC（dsh-pet-bridge:// → helper → stdio），
 * 不经过 HTTP，插件在路由层拦不到；唯一能同时覆盖「管道 + HTTP」的位置是 chatWithPet 内部。
 * 所以安装完成后必须把这段补丁落进 dsh-pet 的产物里，用户才可能「装完重启就能用」。
 *
 * 设计原则：**永不阻断安装**。任何异常都只打日志、以 0 退出。
 */
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const pkgRoot = dirname(here) // 本包根目录（.../node_modules/dsh-pet-task-ctl）
const cli = join(here, 'patch-dsh-pet.mjs')

function log(msg) {
	process.stdout.write(`[dsh-pet-task-ctl/postinstall] ${msg}\n`)
}

// 只处理与本包同级的 dsh-pet（profile/node_modules 布局），其它位置交给运行时自愈
const candidates = [
	join(pkgRoot, '..', 'dsh-pet', 'lib', 'index.js'),
	join(pkgRoot, '..', '..', 'dsh-pet', 'lib', 'index.js'),
]
const target = candidates.find((p) => existsSync(p))

if (target === undefined) {
	log('未找到同级的 dsh-pet，跳过预打补丁（插件启动时会再尝试一次）')
	process.exit(0)
}

if (!existsSync(cli)) {
	log('补丁脚本缺失，跳过')
	process.exit(0)
}

const result = spawnSync(process.execPath, [cli, 'apply', '--target', target], {
	encoding: 'utf8',
	stdio: ['ignore', 'pipe', 'pipe'],
})

const out = `${result.stdout ?? ''}${result.stderr ?? ''}`.trim()
if (out !== '') log(out.replace(/\n/g, '\n[dsh-pet-task-ctl/postinstall] '))

if (result.status !== 0) {
	log('预打补丁未成功（不影响安装）；插件首次启动时还会再试一次')
}
process.exit(0)

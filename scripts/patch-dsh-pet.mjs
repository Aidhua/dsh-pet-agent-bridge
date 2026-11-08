#!/usr/bin/env node
/**
 * dsh-pet 聊天入口补丁工具（幂等 + 可回滚 + 版本校验）
 *
 * 为什么需要它：dsh-pet 0.4.5 的 `chatWithPet` 是模块内闭包函数，没有注册表可供插件挂载，
 * 所以桥接要接进聊天入口，只能在这份编译产物里插一段转调用。本脚本把这个动作固化下来，
 * 用户不必手改文件，也不必担心重复打补丁。
 *
 * 用法：
 *   node scripts/patch-dsh-pet.mjs            # 等同 check：只体检，不改文件
 *   node scripts/patch-dsh-pet.mjs check
 *   node scripts/patch-dsh-pet.mjs apply      # 打补丁（已打过则跳过）
 *   node scripts/patch-dsh-pet.mjs revert     # 从 .orig-backup 还原，或按标记摘除
 *
 * 参数：
 *   --target <file>   直接指定 dsh-pet 的 lib/index.js（测试或非标准安装位置用）
 *   --force           跳过版本/完整性校验（不推荐，仅用于已知安全的定制版本）
 *
 * 退出码：0 成功／无需变更；1 失败（含校验不通过）。
 */

import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** 已实测通过的 dsh-pet 版本；补丁是按这些版本的结构写的。 */
const SUPPORTED_VERSIONS = new Set(['0.4.5'])
/** 0.4.5 原始产物 sha256（本次交付的全部 E2E 都跑在这份字节上）。 */
const BASELINE_SHA256 = '19c5587b9508d1da70041f47c49f06c61b94351563c286b49b582d14739ef523'
/** 幂等标记。 */
const MARKER_BEGIN = '[PET-BRIDGE PATCH BEGIN]'
const MARKER_END = '[PET-BRIDGE PATCH END]'
/** 插入锚点：补丁块插在它前面。dsh-pet 改结构时脚本会在此处明确失败，而不是插错位置。 */
const ANCHOR = 'const rounds = memoryRounds(found.conf);'

/** 补丁块（与仓库 patches/ 下那份 diff 逐字一致，缩进用两个制表符）。 */
const PATCH_LINES = [
	'\t\t// [PET-BRIDGE PATCH BEGIN] 桥接命令拦截：/task /memory /称呼 /bridge',
	'\t\t// 未识别的命令原样落回原生流程；petTaskCtl 未加载时整块跳过。',
	'\t\ttry {',
	'\t\t\tconst bridgeGet = ctx.get;',
	'\t\t\tconst bridgeSvc = (typeof bridgeGet === "function" ? bridgeGet.call(ctx, "petTaskCtl", false) : void 0) ?? ctx.petTaskCtl;',
	'\t\t\tif (bridgeSvc && typeof bridgeSvc.handleChatCommand === "function" && typeof text === "string" && text.startsWith("/")) {',
	'\t\t\t\tconst r = await bridgeSvc.handleChatCommand(petId, text);',
	'\t\t\t\tif (r && r.handled === true) {',
	'\t\t\t\t\tconst reply = typeof r.reply === "string" ? r.reply : "";',
	'\t\t\t\t\tconst mem2 = await readMemory();',
	'\t\t\t\t\tconst bucket2 = mem2[found.entry] && typeof mem2[found.entry] === "object" && !Array.isArray(mem2[found.entry]) ? mem2[found.entry] : mem2[found.entry] = {};',
	'\t\t\t\t\tconst entry2 = bucket2[petId] && Array.isArray(bucket2[petId].messages) ? bucket2[petId] : bucket2[petId] = { messages: [] };',
	'\t\t\t\t\tconst now2 = Date.now();',
	'\t\t\t\t\tentry2.messages.push({ role: "user", content: text, ts: now2 });',
	'\t\t\t\t\tentry2.messages.push({ role: "assistant", content: reply, ts: now2 });',
	'\t\t\t\t\tawait writeMemory(mem2);',
	'\t\t\t\t\tif (reply !== "") state.writePet(petId, "say", { text: reply });',
	'\t\t\t\t\treturn { ok: true, text: reply };',
	'\t\t\t\t}',
	'\t\t\t}',
	'\t\t} catch (e) {',
	'\t\t\tlog.warn?.("[dsh-pet] 桥接命令处理失败：" + (e instanceof Error ? e.message : String(e)));',
	'\t\t}',
	'\t\t// [PET-BRIDGE PATCH END]',
]

function out(msg) {
	process.stdout.write(msg + '\n')
}

function fail(msg) {
	process.stderr.write('✖ ' + msg + '\n')
	process.exit(1)
}

function sha256(file) {
	return createHash('sha256').update(readFileSync(file)).digest('hex')
}

/** 解析 --target / --force 与子命令。 */
function parseArgs(argv) {
	const opts = { command: 'check', target: undefined, force: false }
	for (let i = 0; i < argv.length; i += 1) {
		const a = argv[i]
		if (a === '--target') {
			opts.target = argv[i + 1]
			i += 1
		} else if (a === '--force') {
			opts.force = true
		} else if (['check', 'apply', 'revert'].includes(a)) {
			opts.command = a
		} else if (a === '-h' || a === '--help') {
			opts.command = 'help'
		} else {
			fail('未知参数：' + a + '（可用：check / apply / revert / --target <file> / --force）')
		}
	}
	return opts
}

/**
 * 找到 dsh-pet 的 lib/index.js 与版本。
 * 依次尝试：--target → 当前目录的 node_modules → 从本包位置向上找 node_modules。
 */
function locate(target) {
	if (target !== undefined) {
		const file = resolve(target)
		if (!existsSync(file)) fail('目标文件不存在：' + file)
		return { file, version: versionOf(dirname(dirname(file))) ?? 'unknown' }
	}
	const require = createRequire(import.meta.url)
	const roots = []
	roots.push(process.cwd())
	roots.push(join(dirname(fileURLToPath(import.meta.url)), '..', '..'))
	for (const root of roots) {
		const candidate = join(root, 'node_modules', 'dsh-pet', 'lib', 'index.js')
		if (existsSync(candidate)) return { file: candidate, version: versionOf(join(root, 'node_modules', 'dsh-pet')) ?? 'unknown' }
	}
	try {
		const pkg = require.resolve('dsh-pet/package.json', { paths: [process.cwd()] })
		const base = dirname(pkg)
		const file = join(base, 'lib', 'index.js')
		if (existsSync(file)) return { file, version: versionOf(base) ?? 'unknown' }
	} catch {
		/* 落到下面的统一报错 */
	}
	return fail('找不到 dsh-pet。请在装有 dsh-pet 的 profile 目录执行，或用 --target 指定 lib/index.js')
}

function versionOf(pkgDir) {
	try {
		return JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8')).version ?? null
	} catch {
		return null
	}
}

function hasPatch(text) {
	return text.includes(MARKER_BEGIN) && text.includes(MARKER_END)
}

function stripPatch(text) {
	const begin = text.indexOf(MARKER_BEGIN)
	const end = text.indexOf(MARKER_END)
	if (begin < 0 || end < 0) return text
	// 往前吃掉行首空白与上一个换行，往后吃掉到下一个换行
	const lineStart = text.lastIndexOf('\n', begin) + 1
	const lineEnd = text.indexOf('\n', end)
	return text.slice(0, lineStart) + (lineEnd < 0 ? '' : text.slice(lineEnd + 1))
}

function detectEol(text) {
	return text.includes('\r\n') ? '\r\n' : '\n'
}

function doCheck(ctx) {
	const text = readFileSync(ctx.file, 'utf8')
	const patched = hasPatch(text)
	const hash = sha256(ctx.file)
	const backup = ctx.file + '.orig-backup'
	out('dsh-pet 位置：' + ctx.file)
	out('版本：' + ctx.version + (SUPPORTED_VERSIONS.has(ctx.version) ? '（已支持）' : '（未在实测范围内）'))
	out('补丁状态：' + (patched ? '已打（PET-BRIDGE PATCH 在位）' : '未打'))
	out('当前 sha256：' + hash)
	if (hash === BASELINE_SHA256) out('字节校验：与 0.4.5 原始产物一致')
	else if (patched) out('字节校验：非原始产物（已含补丁，属正常）')
	else out('字节校验：与 0.4.5 原始产物不一致 —— 可能是别的版本或被其它修改动过')
	out('备份文件：' + (existsSync(backup) ? '有（' + backup + '）' : '无'))
	return 0
}

function doApply(ctx, force) {
	if (!SUPPORTED_VERSIONS.has(ctx.version) && !force) {
		fail('未实测的 dsh-pet 版本：' + ctx.version + '。确认安全可用 --force 强制继续。')
	}
	let text = readFileSync(ctx.file, 'utf8')
	if (hasPatch(text)) {
		out('✓ 已经打过补丁，无需重复操作。')
		return 0
	}
	const hash = sha256(ctx.file)
	if (hash !== BASELINE_SHA256 && !force) {
		fail(
			'当前文件不是 dsh-pet 0.4.5 的原始产物（sha256 不匹配），为免插错位置已中止。\n' +
				'  若你确认这是可安全修改的定制版本，加 --force 重试。',
		)
	}
	if (!text.includes(ANCHOR)) {
		fail('找不到插入锚点 `' + ANCHOR + '`，该版本结构与 0.4.5 不同，请改用 patches/ 下的 diff 人工处理。')
	}
	// 备份只在首次打补丁时创建，避免把已打补丁的版本当成原始基线保存下来。
	const backup = ctx.file + '.orig-backup'
	if (!existsSync(backup)) copyFileSync(ctx.file, backup)

	const eol = detectEol(text)
	const block = PATCH_LINES.join(eol) + eol
	const idx = text.indexOf(ANCHOR)
	const lineStart = text.lastIndexOf('\n', idx) + 1
	text = text.slice(0, lineStart) + block + text.slice(lineStart)
	writeFileSync(ctx.file, text, 'utf8')
	out('✓ 补丁已写入：' + ctx.file)
	out('  备份：' + backup)
	out('  下一步：重启 DSH，进入宠物聊天框输入 /bridge 验证。')
	return 0
}

function doRevert(ctx) {
	const backup = ctx.file + '.orig-backup'
	if (existsSync(backup)) {
		copyFileSync(backup, ctx.file)
		out('✓ 已从备份还原：' + backup + ' → ' + ctx.file)
		out('  备份文件保留，便于再次打补丁；确认无碍后可自行删除。')
		return 0
	}
	const text = readFileSync(ctx.file, 'utf8')
	if (!hasPatch(text)) {
		out('✓ 未检测到补丁，无需还原。')
		return 0
	}
	writeFileSync(ctx.file, stripPatch(text), 'utf8')
	out('✓ 已按标记摘除补丁（无备份文件可用）。')
	return 0
}

function usage() {
	out(`dsh-pet 桥接补丁工具

  node scripts/patch-dsh-pet.mjs [check|apply|revert] [--target <lib/index.js>] [--force]

  check   只体检：位置/版本/是否已打/备份是否存在（默认）
  apply   打补丁；已打过则跳过；首次会备份为 index.js.orig-backup
  revert  还原：优先用备份，没有备份则按标记摘除
`)
	return 0
}

function main() {
	const opts = parseArgs(process.argv.slice(2))
	if (opts.command === 'help') return usage()
	const ctx = locate(opts.target)
	if (opts.command === 'check') return doCheck(ctx)
	if (opts.command === 'apply') return doApply(ctx, opts.force)
	return doRevert(ctx)
}

process.exit(main())

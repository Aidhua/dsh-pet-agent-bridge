// ============================================================================
// dsh-pet-task-ctl — v0.2.0 "pet bridge" (DEV ONLY, petlab isolated env)
// ----------------------------------------------------------------------------
// Base architecture: PC2005-cloud/dsh-pet 0.4.5 (MIT, Copyright (c) PC2005).
// This file is a development companion bundle, NOT part of upstream dsh-pet.
//
// Host-half responsibilities (inside the DSH process):
//   1. Agent Task Controller (M1/M1.1, unchanged semantics):
//      - watches a local request directory for TEST-ENTRY task files
//      - creates or reuses a DSH Session via native SessionController
//      - submits task text via sessionController.prompt()
//      - tracks session events into a per-task state machine
//      - result files under <home>/dsh-pet-task-ctl/results/
//   2. NEW (M2 bridge): cordis service "petTaskCtl" consumed by a small
//      intercept patch inside dsh-pet's chatWithPet — the pet chat window
//      (web panel AND desktop helper, both POST /chat) gains commands:
//        /task <text>            submit an Agent task (per-pet session reuse)
//        /task status [id]       status of latest (or given) task
//        /task list              recent tasks
//        /task cancel [id]       cancel latest (or given) task
//        /memory list|add|del|clear   long-term preference memory
//        /称呼 <name> /owner <name>   owner nickname
//        /bridge                 command help
//   3. NEW: long-term pet memory store (pet-memory.json) — owner name +
//      preference list per pet. Injected into BOTH:
//        - pet chat system prompt, via the OFFICIAL dsh-pet memory-provider
//          registry (petApi7340.memory.register, single external slot)
//        - every Agent task submission, as a compact context header
//      One store, two surfaces — no "knows it in chat, forgets it at work".
//
// DSH API used (verified against deepseek-harness 0.2.2-rc.1 source):
//   - ctx.sessionController.create/prompt/cancel/updateQueue
//     (packages/api/session-controller/src/index.ts:306/467/519/509)
//   - ctx.agents.get(sessionId).inbox.nextTurn/nextStep  (queued item lookup
//     by message.source.rpcId === requestId)
//   - ctx.on('session/event', ...)  (packages/core/session/src/index.ts:76)
//   - ctx.provide('petTaskCtl', ...) — same pattern as dsh-pet's own
//     ctx.provide('petApi7340', ...) (lib/index.js:2380 of dsh-pet 0.4.5)
//   - petApi7340.memory.register({id, recall, capture})
//     (dsh-pet lib/index.js:506-526 — single external provider slot)
//
// Status display: task sessions are ordinary DSH sessions, so dsh-pet's own
// session-notify pipeline (createSessionNotify) already maps them onto the
// pet's work status (thinking/working/waiting/success/error) and completion
// bubbles. This bridge deliberately emits nothing visual itself.
// ============================================================================

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";

const PLUGIN_ID = "dsh-pet-task-ctl";
const POLL_MS = 300;
const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_CHAT_TIMEOUT_MS = 10 * 60_000; // real Agent tasks run longer than chat turns
const MIN_TIMEOUT_MS = 5_000;
const MAX_TIMEOUT_MS = 30 * 60_000;
const HISTORY_CAP = 50;

// ---- M1.1 hardening limits -------------------------------------------------
/** Safe request id: starts alnum, then alnum/./_/- only, <=64 chars. */
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
/** Session id shape as minted by DSH ("session-<uuid>"). */
const SESSION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{1,127}$/;
const MAX_REQ_FILE_BYTES = 1_000_000;
const MAX_TEXT_CHARS = 200_000;
const MAX_CWD_CHARS = 512;
/** After cancel is admitted to a live agent, how long to wait for the
 *  turn/end event before declaring the cancellation unconfirmed. */
const CANCEL_GRACE_MS = 15_000;
/** Long-term memory limits: keep it a simple, explainable list. */
const MAX_PREFS = 50;
const MAX_PREF_CHARS = 200;
const MAX_OWNER_CHARS = 32;

/** Terminal states stop all transitions. */
const TERMINAL = new Set(["completed", "failed", "cancelled"]);

const name = PLUGIN_ID;
const inject = ["sessionController", "agents"];

function log(msg) {
	console.log(`[${PLUGIN_ID}] ${msg}`);
}

/**
 * 原子写 JSON。
 *
 * Windows 上 `rename` 到「正被别的进程读着」的目标会抛 EACCES/EPERM，而这一步失败
 * 会让结果文件停在旧状态——曾经出现过「任务已 cancelled，但 json 永远 running」。
 * 所以这里退一步重试、必要时先删目标再放，最后兜底直写，并且无论成败都不留 .tmp 垃圾。
 */
function atomicWriteJson(file, value) {
	const payload = JSON.stringify(value, null, 2);
	const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
	fs.writeFileSync(tmp, payload, "utf8");
	// 20ms 起步、最多 6 次：够覆盖杀毒/资源管理器短暂占用，又不至于卡住主循环。
	const sleepCell = new Int32Array(new SharedArrayBuffer(4));
	for (let attempt = 0; attempt < 6; attempt += 1) {
		try {
			fs.renameSync(tmp, file);
			return;
		} catch {
			/* fallthrough：先尝试清掉目标，再放一次 */
		}
		try {
			fs.unlinkSync(file);
		} catch {
			/* 目标不存在也正常 */
		}
		try {
			fs.renameSync(tmp, file);
			return;
		} catch {
			Atomics.wait(sleepCell, 0, 0, 20 * (attempt + 1));
		}
	}
	try {
		fs.writeFileSync(file, payload, "utf8");
	} finally {
		try {
			fs.unlinkSync(tmp);
		} catch {
			/* 已被 rename 掉则忽略 */
		}
	}
}

function nowIso() {
	return new Date().toISOString();
}

/** Force an arbitrary string into a safe file-name fragment. */
function sanitizeIdFragment(raw) {
	const cleaned = String(raw ?? "").replace(/[^A-Za-z0-9._-]/g, "_").replace(/^\.+/, "_").slice(0, 64);
	return cleaned === "" ? "malformed" : cleaned;
}

function safeService(ctx, id) {
	try {
		const viaGet = typeof ctx?.get === "function" ? ctx.get(id) : undefined;
		return viaGet ?? ctx?.[id] ?? undefined;
	} catch {
		return undefined;
	}
}

// ---- chat door: 在不改上游文件的前提下接管 POST /dsh-pet-7340/chat ---------
/**
 * DSH 的 webServer 按「最长前缀优先」匹配路由，但同一 (kind, path) 重复注册会抛错，
 * 且公开 API 没有请求中间件。所以这里只做一件事：把 dsh-pet 已注册的那条前缀路由的
 * handler 换成"门房"——非命令请求原样交给原 handler（连请求体都不碰），以 "/" 开头的
 * 命令就地应答。找不到路由表就安静放弃，原生聊天完全不受影响。
 */
const PET_ROUTE_PREFIX = "/dsh-pet-7340";
/** 门房标记：避免热重载/重复 install 时把自己再包一层。 */
const DOOR_FLAG = Symbol.for(`${PLUGIN_ID}.chatDoor`);
const MAX_DOOR_BODY_BYTES = 256 * 1024;

/** 读完请求体（带上限）；超限抛 { code: "body-too-large" }。 */
function readRequestBody(req, limit) {
	return new Promise((resolve, reject) => {
		const chunks = [];
		let size = 0;
		req.on("data", (chunk) => {
			size += chunk.length;
			if (size > limit) {
				const err = new Error("request body too large");
				err.code = "body-too-large";
				reject(err);
				return;
			}
			chunks.push(chunk);
		});
		req.on("end", () => resolve(Buffer.concat(chunks)));
		req.on("error", reject);
	});
}

function sendJson(res, status, obj) {
	if (res.destroyed || res.writableEnded) return;
	const body = JSON.stringify(obj);
	res.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(body) });
	res.end(body);
}

/** 把已经读掉的请求体塞回一个新的可读流，交还原 handler（它只用到 url/method/headers/流）。 */
function replayRequest(req, buf) {
	const fake = Readable.from([buf]);
	fake.method = req.method;
	fake.url = req.url;
	fake.headers = req.headers;
	fake.httpVersion = req.httpVersion;
	fake.socket = req.socket;
	fake.destroyed = false;
	return fake;
}

/** 从 `?pet=xxx` 取宠物 id；缺省回落到配置里第一只（这里用 main）。 */
function petIdOfUrl(rawUrl) {
	try {
		const id = new URL(rawUrl ?? "/", "http://127.0.0.1").searchParams.get("pet");
		return typeof id === "string" && id.trim() !== "" ? id.trim() : "main";
	} catch {
		return "main";
	}
}

/** 找到 webServer 内部的路由表（公开 API 不暴露读取，这里只读一次候选属性）。 */
function findRouteTable(web) {
	if (web === undefined || web === null) return null;
	for (const key of ["prefixes", "routes", "routeTable"]) {
		const table = web[key];
		if (table instanceof Map) return table;
		if (table && typeof table.get === "function" && typeof table.set === "function") return table;
	}
	return null;
}

/** 从路由表里挑出 dsh-pet 的那条前缀路由。 */
function findPetRoute(table, prefix) {
	if (!table) return null;
	for (const [key, route] of table) {
		if (!route || typeof route !== "object") continue;
		if (route.kind !== "prefix") continue;
		const routePath = typeof route.path === "string" ? route.path : String(key);
		if (routePath !== prefix) continue;
		if (typeof route.handler !== "function") continue;
		return { key, route, routePath };
	}
	return null;
}

/** Extract plain text from an assistant/message event (defensive walk). */function textOfAssistantMessage(event) {
	const msg = event?.data?.message;
	const parts = msg?.content;
	if (!Array.isArray(parts)) return null;
	const texts = [];
	for (const part of parts) {
		if (part && part.type === "text" && typeof part.text === "string" && part.text.trim() !== "") {
			texts.push(part.text);
		}
	}
	return texts.length > 0 ? texts.join("\n") : null;
}

/** Skip sub-agent sessions so delegated turns never pollute task state. */
function isSubagentSession(session) {
	const header = session?.header;
	if (!header || typeof header !== "object") return false;
	if (header.origin === "subagent") return true;
	const depth = header.delegationDepth;
	return typeof depth === "number" && Number.isFinite(depth) && depth > 0;
}

function sessionIdOf(session) {
	return String(session?.header?.id ?? session?.id ?? "");
}

function apply(ctx) {
	// ---- layout -------------------------------------------------------------
	const homeRoot = process.env.DSH_HOME && process.env.DSH_HOME.trim() !== ""
		? path.resolve(process.env.DSH_HOME.trim())
		: path.join(os.homedir(), ".dsh");
	const baseDir = path.join(homeRoot, PLUGIN_ID);
	const reqDir = path.join(baseDir, "requests");
	const resDir = path.join(baseDir, "results");
	const defaultCwd = path.join(baseDir, "test-workspace");
	const memFile = path.join(baseDir, "pet-memory.json");
	for (const dir of [baseDir, reqDir, resDir, defaultCwd]) fs.mkdirSync(dir, { recursive: true });

	// ---- state --------------------------------------------------------------
	/** taskId -> task record */
	const tasks = new Map();
	/** taskId -> NodeJS.Timeout (watchdog / cancel grace) */
	const timers = new Map();
	/** sessionId -> in-flight taskId (one task per session, M1 scope) */
	const activeBySession = new Map();
	/** requestId -> true (dedup cache; request files are deleted after pickup) */
	const seenRequests = new Map();
	/** auto-increment for chat task ids */
	let chatSeq = 0;

	log(`initialized. home=${homeRoot} requests=${reqDir}`);

	// =========================================================================
	// Long-term pet memory (owner name + preference list, per pet)
	// =========================================================================
	let petMem = { pets: {} };
	try {
		const raw = JSON.parse(fs.readFileSync(memFile, "utf8"));
		if (raw !== null && typeof raw === "object" && !Array.isArray(raw) && raw.pets && typeof raw.pets === "object") {
			petMem = raw;
		}
	} catch { /* first run or corrupted — start fresh */ }

	function petMemOf(petId) {
		const id = sanitizeIdFragment(petId);
		if (petMem.pets[id] === undefined || petMem.pets[id] === null || typeof petMem.pets[id] !== "object") {
			petMem.pets[id] = { ownerName: undefined, prefs: [], taskSessionId: undefined };
		}
		const slot = petMem.pets[id];
		if (!Array.isArray(slot.prefs)) slot.prefs = [];
		return slot;
	}
	function savePetMem() {
		try {
			atomicWriteJson(memFile, petMem);
		} catch (err) {
			log(`pet-memory write failed: ${err?.message ?? err}`);
		}
	}

	/** Compact context block shared by chat recall and Agent task headers. */
	function memoryBlockOf(petId) {
		const slot = petMemOf(petId);
		const lines = [];
		if (typeof slot.ownerName === "string" && slot.ownerName !== "") lines.push(`主人称呼：${slot.ownerName}`);
		const prefs = slot.prefs.filter((p) => p && typeof p.text === "string" && p.text !== "");
		if (prefs.length > 0) lines.push(`主人偏好：${prefs.map((p) => p.text).join("；")}`);
		return lines.length > 0 ? `[长期记忆] ${lines.join("。")}` : "";
	}

	// ---- official dsh-pet memory-provider registration ----------------------
	// dsh-pet exposes a single external slot: petApi7340.memory.register.
	// recall() may patch {system,userText,history} for each chat turn; returning
	// undefined keeps the native path untouched. Load order between bundles is
	// not guaranteed, so registration retries quietly until dsh-pet is up.
	let unregisterMemProvider = null;
	function registerMemoryProvider() {
		const api = safeService(ctx, "petApi7340");
		const reg = api?.memory?.register;
		if (typeof reg !== "function") return false;
		try {
			unregisterMemProvider = reg({
				id: "pet-task-bridge",
				recall: ({ petId, system }) => {
					const block = memoryBlockOf(petId);
					if (block === "" || typeof system !== "string" || system === "") return undefined;
					return { system: `${system}\n${block}` };
				},
			});
			log("registered as dsh-pet chat memory provider (id=pet-task-bridge)");
			return true;
		} catch (err) {
			log(`memory provider registration failed: ${err?.message ?? err}`);
			return false;
		}
	}
	let memRetryTimer = null;
	if (!registerMemoryProvider()) {
		memRetryTimer = setInterval(() => {
			if (registerMemoryProvider()) clearInterval(memRetryTimer);
		}, 2000);
		memRetryTimer.unref?.();
	}

	// ---- result writing -----------------------------------------------------
	function pushHistory(task, state, detail) {
		task.history.push({ ts: nowIso(), state, ...(detail === undefined ? {} : { detail }) });
		if (task.history.length > HISTORY_CAP) task.history.splice(0, task.history.length - HISTORY_CAP);
	}

	function writeResult(task) {
		task.updatedAt = nowIso();
		const file = path.join(resDir, `task-${task.id}.json`);
		const snapshot = {
			id: task.id,
			requestId: task.requestId,
			sessionId: task.sessionId,
			state: task.state,
			simulated: task.simulated === true,
			createdAt: task.createdAt,
			updatedAt: task.updatedAt,
			...(task.execution === undefined ? {} : { execution: task.execution }),
			history: task.history,
			...(task.resultText === undefined ? {} : { resultText: task.resultText }),
			...(task.error === undefined ? {} : { error: task.error }),
			...(task.turnEndReason === undefined ? {} : { turnEndReason: task.turnEndReason }),
			...(task.warnings === undefined ? {} : { warnings: task.warnings }),
		};
		try {
			atomicWriteJson(file, snapshot);
		} catch (err) {
			log(`writeResult failed for ${task.id}: ${err?.message ?? err}`);
		}
	}

	function transition(task, state, detail) {
		if (TERMINAL.has(task.state)) return;
		task.state = state;
		pushHistory(task, state, detail);
		writeResult(task);
		log(`task ${task.id} -> ${state}${detail ? ` (${typeof detail === "string" ? detail : JSON.stringify(detail)})` : ""}`);
	}

	function clearTimers(task) {
		for (const key of [task.id, `${task.id}:grace`]) {
			const timer = timers.get(key);
			if (timer !== undefined) { clearTimeout(timer); timers.delete(key); }
		}
	}

	function finish(task, state, detail, extra = {}) {
		if (TERMINAL.has(task.state)) return;
		clearTimers(task);
		if (task.sessionId !== undefined && activeBySession.get(task.sessionId) === task.id) {
			activeBySession.delete(task.sessionId);
		}
		transition(task, state, detail);
		Object.assign(task, extra);
		writeResult(task);
	}

	// ---- session event tracking ---------------------------------------------
	const offSessionEvent = ctx.on("session/event", (session, event) => {
		try {
			if (isSubagentSession(session)) return;
			const sid = sessionIdOf(session);
			if (sid === "") return;
			const taskId = activeBySession.get(sid);
			if (taskId === undefined) return;
			const task = tasks.get(taskId);
			if (task === undefined || task.simulated) return;
			handleSessionEvent(task, event);
		} catch (err) {
			log(`session/event handler error: ${err?.message ?? err}`);
		}
	});

	function handleSessionEvent(task, event) {
		const type = event?.type;
		switch (type) {
			case "turn/start": {
				task.execution = "live";
				transition(task, "running", "turn/start");
				break;
			}
			case "tool/call": {
				const toolName = typeof event?.data?.name === "string" ? event.data.name : "unknown";
				transition(task, "running", { tool: toolName, callId: event?.data?.callId });
				break;
			}
			case "approval/asked": {
				transition(task, "waiting_approval", {
					approvalId: event?.data?.id,
					toolName: event?.data?.toolName,
				});
				break;
			}
			case "approval/decided": {
				transition(task, "running", { approvalDecided: event?.data?.outcome, approvalId: event?.data?.id });
				break;
			}
			case "llm/retry":
			case "llm/retry-started": {
				pushHistory(task, task.state, { note: type, reason: event?.data?.reason });
				writeResult(task);
				break;
			}
			case "assistant/message": {
				const text = textOfAssistantMessage(event);
				if (text !== null) task.resultText = text;
				break;
			}
			case "tool/result": {
				const callId = event?.data?.message?.source?.callId;
				pushHistory(task, task.state, { note: "tool/result", callId });
				writeResult(task);
				break;
			}
			case "turn/end": {
				const reason = event?.data?.reason;
				const kind = reason?.kind;
				task.turnEndReason = kind ?? JSON.stringify(reason ?? null);
				if (kind === "completed") {
					finish(task, "completed", task.cancelling
						? { turnEndReason: task.turnEndReason, note: "turn completed while cancel was in flight" }
						: "turn/end completed");
				} else if (kind === "aborted") {
					finish(task, "cancelled", {
						turnEndReason: task.turnEndReason,
						...(task.cancelling ? { cancelledVia: "session/cancel" } : {}),
						detail: reason,
					});
				} else {
					finish(task, "failed", { turnEndReason: task.turnEndReason, detail: reason });
				}
				break;
			}
			default:
				break;
		}
	}

	// ---- cancellation & timeout ---------------------------------------------
	function findQueuedItemId(task) {
		if (task.sessionId === undefined) return undefined;
		try {
			const agent = ctx.agents?.get?.(task.sessionId);
			if (agent === undefined || agent === null) return undefined;
			const inbox = agent.inbox;
			if (inbox === undefined || inbox === null) return undefined;
			const items = [
				...(Array.isArray(inbox.nextTurn) ? inbox.nextTurn : []),
				...(Array.isArray(inbox.nextStep) ? inbox.nextStep : []),
			];
			const mine = items.find((m) => m !== null && typeof m === "object"
				&& m?.source?.kind === "user" && m?.source?.rpcId === task.requestId);
			return mine?.id;
		} catch {
			return undefined;
		}
	}

	function retractQueued(task, cause) {
		const itemId = findQueuedItemId(task);
		if (itemId === undefined) return false;
		try {
			ctx.sessionController.updateQueue({
				sessionId: task.sessionId,
				itemId,
				action: { kind: "remove" },
			}).then(
				() => {
					finish(task, "cancelled", { cause, cancelledVia: "updateQueue.remove", itemId });
				},
				(err) => {
					const code = err?.code ?? err?.name;
					log(`task ${task.id} queue retract failed (${String(code ?? err)}); falling back to live cancel`);
					cancelLiveTurn(task, cause);
				},
			);
			return true;
		} catch (err) {
			log(`task ${task.id} updateQueue threw: ${err?.message ?? err}`);
			return false;
		}
	}

	function cancelLiveTurn(task, cause) {
		if (TERMINAL.has(task.state)) return;
		const controller = ctx.sessionController;
		try {
			const receipt = controller.cancel({ sessionId: task.sessionId });
			task.cancelling = true;
			pushHistory(task, task.state, { note: "cancel-admitted", cause, ...(receipt === undefined ? {} : { receipt }) });
			writeResult(task);
			const grace = setTimeout(() => {
				timers.delete(`${task.id}:grace`);
				if (TERMINAL.has(task.state)) return;
				finish(task, "failed", { cause, cancelError: "cancel-unconfirmed: no turn/end within grace period" });
			}, CANCEL_GRACE_MS);
			timers.set(`${task.id}:grace`, grace);
		} catch (err) {
			const code = err?.code ?? err?.name;
			finish(task, "failed", {
				cause,
				cancelError: String(code ?? err),
				note: "no live agent on session; cancellation unconfirmed",
			});
		}
	}

	function cancelTask(task, cause) {
		if (TERMINAL.has(task.state)) return;
		if (task.simulated === true) {
			finish(task, "cancelled", { cause, cancelledVia: "simulated" });
			return;
		}
		if (task.sessionId === undefined) {
			task.pendingCancel = { cause };
			pushHistory(task, task.state, { note: "cancel-deferred", cause });
			writeResult(task);
			return;
		}
		if (retractQueued(task, cause)) return;
		if (task.promptSettled !== true && task.abort !== undefined) {
			task.cancelling = true;
			task.cancelCause = cause;
			pushHistory(task, task.state, { note: "cancel: aborting prompt admission", cause });
			writeResult(task);
			try { task.abort.abort(); } catch { /* ignore */ }
			return;
		}
		cancelLiveTurn(task, cause);
	}

	function armTimeout(task) {
		const ms = Math.min(Math.max(Number(task.timeoutMs) || DEFAULT_TIMEOUT_MS, MIN_TIMEOUT_MS), MAX_TIMEOUT_MS);
		const timer = setTimeout(() => {
			timers.delete(task.id);
			if (TERMINAL.has(task.state)) return;
			log(`task ${task.id} timeout after ${ms}ms`);
			pushHistory(task, task.state, { note: "timeout", ms });
			cancelTask(task, `timeout ${ms}ms`);
		}, ms);
		timers.set(task.id, timer);
	}

	// ---- simulated mode -------------------------------------------------------
	function runSimulated(task) {
		log(`task ${task.id} SIMULATED run (marked simulated=true; NOT a real Agent execution)`);
		transition(task, "accepted", "simulated");
		setTimeout(() => transition(task, "running", "simulated"), 200);
		setTimeout(() => {
			if (task.simulateApproval === true) transition(task, "waiting_approval", "simulated");
		}, 400);
		setTimeout(() => {
			if (task.simulateApproval === true) transition(task, "running", "simulated approval auto-returned");
			finish(task, "completed", "simulated", {
				resultText: "[SIMULATED] task controller state machine finished — no Agent, no model, no filesystem effect",
			});
		}, task.simulateApproval === true ? 900 : 700);
	}

	// ---- task submission core (shared by file entry and chat commands) -------
	function startTask(task, text, opts = {}) {
		tasks.set(task.id, task);
		const controller = ctx.sessionController;
		const reuseSessionId = typeof opts.sessionId === "string" && opts.sessionId !== "" ? opts.sessionId : undefined;
		const cwd = typeof opts.cwd === "string" && opts.cwd !== "" ? opts.cwd : defaultCwd;
		const ensureSession = reuseSessionId !== undefined
			? Promise.resolve({ sessionId: reuseSessionId })
			: controller.create({ cwd });

		ensureSession.then(
			(created) => {
				try {
					if (TERMINAL.has(task.state)) return;
					task.sessionId = String(created.sessionId);
					pushHistory(task, "accepted", `session ${task.sessionId}${typeof created.agentPreset === "string" ? ` preset=${created.agentPreset}` : ""}`);
					if (task.pendingCancel !== undefined) {
						const pending = task.pendingCancel;
						delete task.pendingCancel;
						finish(task, "cancelled", { cause: pending.cause, cancelledVia: "pre-admission" });
						return;
					}
					if (activeBySession.has(task.sessionId)) {
						finish(task, "failed", { cause: "task-ctl/session-busy", session: task.sessionId });
						return;
					}
					activeBySession.set(task.sessionId, task.id);
					writeResult(task);
					armTimeout(task);
					const abort = new AbortController();
					task.abort = abort;
					controller.prompt({
						requestId: task.id,
						sessionId: task.sessionId,
						mode: "queue",
						content: [{ type: "text", text }],
					}, abort.signal).then(
						() => {
							log(`task ${task.id} prompt accepted by session ${task.sessionId}`);
							task.promptSettled = true;
							let agentStatus;
							try { agentStatus = ctx.agents?.get?.(task.sessionId)?.status; } catch { /* ignore */ }
							if (agentStatus === "running" && task.state === "accepted") {
								task.execution = "queued";
								transition(task, "queued", "prompt parked in inbox (another turn is active)");
							} else {
								pushHistory(task, task.state, "prompt accepted");
							}
							writeResult(task);
						},
						(err) => {
							task.promptSettled = true;
							if (task.cancelling && (err?.name === "AbortError" || abort.signal.aborted)) {
								finish(task, "cancelled", { cause: task.cancelCause ?? "user-cancel", cancelledVia: "prompt-admission-aborted" });
								return;
							}
							finish(task, "failed", {
								cause: "prompt-rejected",
								code: err?.code ?? err?.name,
								message: String(err?.message ?? err),
							});
						},
					);
				} catch (err) {
					finish(task, "failed", { cause: "internal-error", message: String(err?.stack ?? err) });
				}
			},
			(err) => {
				finish(task, "failed", {
					cause: "session-create-failed",
					code: err?.code ?? err?.name,
					message: String(err?.message ?? err),
				});
			},
		);
	}

	// ---- file request entry (TEST ONLY; product channel is chat commands) ----
	function failNewRequest(id, error, extra = {}) {
		const task = {
			id, requestId: id, sessionId: undefined, state: "failed",
			simulated: false, createdAt: nowIso(), updatedAt: nowIso(),
			history: [{ ts: nowIso(), state: "failed", detail: error }], error,
		};
		Object.assign(task, extra);
		writeResult(task);
		log(`request ${id} rejected: ${error}`);
	}

	function validateRequestShape(req) {
		if (req === null || typeof req !== "object" || Array.isArray(req)) {
			return "request must be a JSON object";
		}
		if (Object.keys(req).length > 32) return "request has too many fields";
		return null;
	}

	function handleSubmit(req) {
		const rawId = typeof req.id === "string" ? req.id.trim() : "";
		if (rawId === "" || rawId.length > 64 || !ID_RE.test(rawId)) {
			failNewRequest(sanitizeIdFragment(rawId || "malformed"),
				"invalid-request: id must match /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/ (UUIDs are fine)");
			return;
		}
		const id = rawId;
		if (seenRequests.has(id)) {
			writeResult({
				id: `${id}.duplicate`, requestId: id, sessionId: tasks.get(id)?.sessionId, state: tasks.get(id)?.state ?? "unknown",
				simulated: req.simulate === true, createdAt: nowIso(), updatedAt: nowIso(),
				history: [{ ts: nowIso(), state: "duplicate", detail: `request id ${id} was already accepted` }],
				warnings: ["duplicate-request-id"],
			});
			log(`duplicate request id ${id} ignored`);
			return;
		}
		seenRequests.set(id, true);

		if (req.simulate === true) {
			const task = {
				id, requestId: id, sessionId: "simulated", state: "accepted",
				simulated: true, simulateApproval: req.simulateApproval === true,
				timeoutMs: req.timeoutMs, createdAt: nowIso(), updatedAt: nowIso(), history: [],
			};
			writeResult(task);
			runSimulated(task);
			return;
		}

		const text = typeof req.text === "string" ? req.text : "";
		if (text.trim() === "") {
			failNewRequest(id, "invalid-request: text must be a non-empty string");
			return;
		}
		if (text.length > MAX_TEXT_CHARS) {
			failNewRequest(id, `invalid-request: text exceeds ${MAX_TEXT_CHARS} characters`);
			return;
		}

		let reuseSessionId;
		if (req.sessionId !== undefined && req.sessionId !== null) {
			if (typeof req.sessionId !== "string" || !SESSION_ID_RE.test(req.sessionId.trim())) {
				failNewRequest(id, "invalid-request: sessionId must match /^[A-Za-z0-9][A-Za-z0-9._-]{1,127}$/");
				return;
			}
			reuseSessionId = req.sessionId.trim();
		}

		let cwd;
		if (req.cwd !== undefined && req.cwd !== null) {
			if (typeof req.cwd !== "string" || req.cwd.trim() === "" || !path.isAbsolute(req.cwd.trim())
				|| req.cwd.trim().length > MAX_CWD_CHARS) {
				failNewRequest(id, `invalid-request: cwd must be an absolute path of at most ${MAX_CWD_CHARS} characters`);
				return;
			}
			cwd = req.cwd.trim();
		}

		const task = {
			id, requestId: id, sessionId: undefined, state: "accepted",
			simulated: false, timeoutMs: req.timeoutMs, via: "file",
			createdAt: nowIso(), updatedAt: nowIso(), history: [],
		};
		startTask(task, text, { sessionId: reuseSessionId, cwd });
	}

	function handleCancel(req) {
		const taskId = typeof req.taskId === "string" ? req.taskId.trim() : "";
		if (taskId === "" || taskId.length > 64 || !ID_RE.test(taskId) || !tasks.has(taskId)) {
			const rawId = typeof req.id === "string" ? req.id : "";
			failNewRequest(ID_RE.test(rawId.trim()) ? rawId.trim() : sanitizeIdFragment(rawId || "malformed-cancel"),
				"invalid-request: unknown taskId for cancel");
			return;
		}
		cancelTask(tasks.get(taskId), "user-cancel");
	}

	function processRequestFile(filePath) {
		try {
			let stat;
			try {
				stat = fs.statSync(filePath);
			} catch {
				return;
			}
			if (!stat.isFile()) return;
			if (stat.size > MAX_REQ_FILE_BYTES) {
				try { fs.unlinkSync(filePath); } catch { /* ignore */ }
				failNewRequest(sanitizeIdFragment(path.basename(filePath).replace(/\.json$/i, "")),
					`invalid-request: request file exceeds ${MAX_REQ_FILE_BYTES} bytes`);
				return;
			}
			let raw;
			try {
				raw = fs.readFileSync(filePath, "utf8");
			} catch {
				return;
			}
			let req;
			let parseError;
			try {
				req = JSON.parse(raw);
			} catch (err) {
				parseError = err;
			}
			try { fs.unlinkSync(filePath); } catch { /* ignore */ }
			const baseId = sanitizeIdFragment(path.basename(filePath).replace(/\.json$/i, ""));
			if (parseError !== undefined) {
				failNewRequest(baseId, "invalid-json: request file is not valid JSON");
				return;
			}
			const shapeError = validateRequestShape(req);
			if (shapeError !== null) {
				failNewRequest(baseId, `invalid-request: ${shapeError}`);
				return;
			}
			if (req.action === "cancel") handleCancel(req);
			else handleSubmit(req);
		} catch (err) {
			log(`request processing error for ${filePath}: ${err?.stack ?? err}`);
		}
	}

	// =========================================================================
	// Chat command service (product channel for the pet chat window)
	// =========================================================================
	const HELP_TEXT = [
		"【桥接命令】",
		"/task <任务描述> —— 交给 DSH Agent 执行（同一会话可连续交代）",
		"/task status [任务号] —— 查看最近（或指定）任务状态",
		"/task list —— 最近任务列表",
		"/task cancel [任务号] —— 取消任务",
		"/memory list —— 查看长期记忆",
		"/memory add <内容> —— 记住一条偏好",
		"/memory del <序号> —— 删除一条偏好",
		"/memory clear —— 清空偏好（保留称呼）",
		"/称呼 <名字> —— 告诉我该怎么称呼你",
		"/bridge —— 显示本帮助",
	].join("\n");

	function fmtTaskStatus(task) {
		const stateZh = {
			accepted: "已接收",
			queued: "排队中",
			running: "执行中",
			waiting_approval: "等待你在 DSH 中批准",
			completed: "已完成",
			failed: "失败",
			cancelled: "已取消",
		}[task.state] ?? task.state;
		const lines = [`任务 #${task.id}：${stateZh}`];
		if (task.sessionId !== undefined && task.sessionId !== "simulated") lines.push(`会话：${task.sessionId}`);
		if (task.resultText !== undefined) {
			const brief = task.resultText.length > 400 ? `${task.resultText.slice(0, 400)}…` : task.resultText;
			lines.push(`结果：${brief}`);
		}
		if (task.error !== undefined) lines.push(`错误：${JSON.stringify(task.error).slice(0, 300)}`);
		return lines.join("\n");
	}

	/** tasks of one pet, newest first */
	function tasksOfPet(petId) {
		const out = [];
		for (const task of tasks.values()) {
			if (task.petId === petId) out.push(task);
		}
		return out.reverse();
	}

	function submitChatTask(petId, text) {
		const slot = petMemOf(petId);
		const live = tasksOfPet(petId).find((t) => !TERMINAL.has(t.state));
		if (live !== undefined) {
			return `上一条任务 #${live.id} 还没结束（${live.state}）。等它完成，或先 /task cancel 取消它。`;
		}
		chatSeq += 1;
		const id = `chat-${Date.now()}-${chatSeq}`;
		seenRequests.set(id, true);
		const task = {
			id, requestId: id, sessionId: undefined, state: "accepted",
			simulated: false, timeoutMs: DEFAULT_CHAT_TIMEOUT_MS, via: "chat", petId,
			createdAt: nowIso(), updatedAt: nowIso(), history: [],
		};
		tasks.set(id, task);
		// context header: the SAME long-term memory the chat side recalls
		const block = memoryBlockOf(petId);
		const header = (block === "" ? "" : `${block}。`)
			+ "（这是桌面宠物的 Agent 工作模式，请以简体中文完成实际任务，完成后给出关键结果与文件路径。）\n"
			+ text;
		// per-pet workspace so scenario files land in a predictable place
		const petWs = path.join(baseDir, "workspaces", `pet-${sanitizeIdFragment(petId)}`);
		try { fs.mkdirSync(petWs, { recursive: true }); } catch { /* create() will surface the error */ }
		startTask(task, header, { sessionId: slot.taskSessionId, cwd: petWs });
		// remember the session for follow-ups
		const watch = setInterval(() => {
			if (task.sessionId !== undefined || TERMINAL.has(task.state)) {
				clearInterval(watch);
				if (task.sessionId !== undefined && !task.sessionId.startsWith("simulated")) {
					slot.taskSessionId = task.sessionId;
					savePetMem();
				}
			}
		}, 500);
		watch.unref?.();
		return `已收到任务 #${id}，我这就交给 DSH Agent 去办，完成后我的状态会亮起来，也可以用 /task status 查看进度。`;
	}

	function handleTaskCommand(petId, rest) {
		if (rest === "") return HELP_TEXT;
		const [sub, ...args] = rest.split(/\s+/);
		const arg = args.join(" ").trim();
		if (sub === "status") {
			let task;
			if (arg !== "" && ID_RE.test(arg)) task = tasks.get(arg);
			else task = tasksOfPet(petId)[0];
			if (task === undefined) return "还没有任务记录。用 /task <任务描述> 交给我吧。";
			return fmtTaskStatus(task);
		}
		if (sub === "list") {
			const list = tasksOfPet(petId).slice(0, 5);
			if (list.length === 0) return "还没有任务记录。";
			return list.map((t) => `#${t.id} —— ${t.state}`).join("\n");
		}
		if (sub === "cancel") {
			let task;
			if (arg !== "" && ID_RE.test(arg)) task = tasks.get(arg);
			else task = tasksOfPet(petId).find((t) => !TERMINAL.has(t.state));
			if (task === undefined) return "没有正在进行的任务。";
			if (TERMINAL.has(task.state)) return `任务 #${task.id} 已经是终态（${task.state}），无需取消。`;
			cancelTask(task, "user-cancel");
			return `正在取消任务 #${task.id}…`;
		}
		// any other wording — the WHOLE rest is the task text (Chinese often
		// has no spaces, so the first token is not a subcommand marker here)
		return submitChatTask(petId, rest);
	}

	function handleMemoryCommand(petId, rest) {
		const slot = petMemOf(petId);
		if (rest === "" || rest === "list") {
			const lines = [];
			lines.push(slot.ownerName ? `称呼：${slot.ownerName}` : "称呼：还没告诉我，用 /称呼 <名字> 设置");
			if (slot.prefs.length === 0) lines.push("偏好：暂无记录。用 /memory add <内容> 让我记住。");
			else slot.prefs.forEach((p, i) => lines.push(`${i + 1}. ${p.text}`));
			return lines.join("\n");
		}
		const [sub, ...args] = rest.split(/\s+/);
		const arg = args.join(" ").trim();
		if (sub === "add") {
			if (arg === "") return "要记的内容是空的。格式：/memory add 喜欢喝美式咖啡";
			if (arg.length > MAX_PREF_CHARS) return `太长了（限 ${MAX_PREF_CHARS} 字）。`;
			if (slot.prefs.length >= MAX_PREFS) return `偏好已满（${MAX_PREFS} 条），先删几条。`;
			slot.prefs.push({ text: arg, ts: Date.now() });
			savePetMem();
			return `记住了：${arg}`;
		}
		if (sub === "del") {
			const n = Number(arg);
			if (!Number.isInteger(n) || n < 1 || n > slot.prefs.length) return "序号不对。先 /memory list 看一下。";
			const removed = slot.prefs.splice(n - 1, 1)[0];
			savePetMem();
			return `已删除第 ${n} 条：${removed?.text ?? ""}`;
		}
		if (sub === "clear") {
			slot.prefs = [];
			savePetMem();
			return "偏好已清空（称呼保留）。";
		}
		return "格式：/memory list | add <内容> | del <序号> | clear";
	}

	function handleOwnerCommand(petId, rest) {
		const nameArg = rest.trim();
		const slot = petMemOf(petId);
		if (nameArg === "") {
			return slot.ownerName ? `现在称呼你是：${slot.ownerName}` : "还没告诉我怎么称呼你。用 /称呼 <名字> 设置。";
		}
		if (nameArg.length > MAX_OWNER_CHARS) return `名字太长了（限 ${MAX_OWNER_CHARS} 字）。`;
		slot.ownerName = nameArg;
		savePetMem();
		return `好的，以后就叫你「${nameArg}」。`;
	}

	/**
	 * Chat command router. Returns {handled:false} for anything that is not a
	 * bridge command so dsh-pet's native flow (including its own slash
	 * commands) proceeds untouched.
	 */
	async function handleChatCommand(petId, rawText) {
		try {
			const text = typeof rawText === "string" ? rawText : "";
			if (!text.startsWith("/")) return { handled: false };
			const trimmed = text.replace(/^\/+/, "").trim();
			if (trimmed === "") return { handled: false };
			const spaceAt = trimmed.indexOf(" ");
			const cmd = spaceAt === -1 ? trimmed : trimmed.slice(0, spaceAt);
			const rest = spaceAt === -1 ? "" : trimmed.slice(spaceAt + 1).trim();
			if (cmd === "bridge") return { handled: true, reply: HELP_TEXT };
			if (cmd === "task") return { handled: true, reply: handleTaskCommand(petId, rest) };
			if (cmd === "memory" || cmd === "记忆") return { handled: true, reply: handleMemoryCommand(petId, rest) };
			if (cmd === "称呼" || cmd === "owner") return { handled: true, reply: handleOwnerCommand(petId, rest) };
			return { handled: false };
		} catch (err) {
			log(`chat command error: ${err?.stack ?? err}`);
			return { handled: true, reply: `桥接命令处理出错：${err?.message ?? err}` };
		}
	}

	ctx.provide("petTaskCtl", { handleChatCommand });
	log("petTaskCtl service provided (chat command channel ready)");

	// ---- chat door（零补丁接管聊天入口） -------------------------------------
	/** 已安装的门房：用于 dispose 时还原原 handler。 */
	let door = null;
	let doorRetryTimer = null;

	function installChatDoor() {
		if (door !== null) return true;
		const web = safeService(ctx, "webServer");
		if (web === undefined) return false;
		const table = findRouteTable(web);
		const found = findPetRoute(table, PET_ROUTE_PREFIX);
		if (found === null) return false;
		const { key, route } = found;
		const original = route.handler;
		if (original[DOOR_FLAG] === true) {
			// 已被本进程的另一个实例包过（热重载），直接接管所有权标记
			return false;
		}
		const wrapped = async (req, res) => {
			let isChatPost = false;
			try {
				const method = req?.method ?? "GET";
				const raw = req?.url ?? "/";
				const q = raw.indexOf("?");
				const pathname = q < 0 ? raw : raw.slice(0, q);
				isChatPost = method === "POST" && pathname === `${PET_ROUTE_PREFIX}/chat`;
				if (!isChatPost) return original(req, res);

				const buf = await readRequestBody(req, MAX_DOOR_BODY_BYTES);
				let parsed = {};
				try {
					parsed = JSON.parse(buf.toString("utf8") || "{}") ?? {};
				} catch {
					sendJson(res, 400, { ok: false, reason: "invalid-json", message: "invalid JSON body" });
					return undefined;
				}
				const text = typeof parsed.text === "string" ? parsed.text.trim() : "";
				// 不是命令：连请求体一起还给原生流程，宠物聊天照旧
				if (!text.startsWith("/")) return original(replayRequest(req, buf), res);

				const petId = petIdOfUrl(raw);
				const outcome = await handleChatCommand(petId, text);
				if (!outcome || outcome.handled !== true) return original(replayRequest(req, buf), res);
				sendJson(res, 200, { ok: true, text: typeof outcome.reply === "string" ? outcome.reply : "" });
				return undefined;
			} catch (err) {
				if (err && err.code === "body-too-large") {
					sendJson(res, 413, { ok: false, reason: "payload-too-large", message: "request body too large" });
					return undefined;
				}
				log(`chat door failed: ${err instanceof Error ? err.message : String(err)}`);
				// 出错时尽量退回原生路径；请求体若已被读掉，只能给一句可读的错误
				if (!isChatPost) return original(req, res);
				sendJson(res, 500, { ok: false, reason: "internal-error", message: "dsh-pet task bridge: internal error" });
				return undefined;
			}
		};
		wrapped[DOOR_FLAG] = true;
		table.set(key, { ...route, handler: wrapped });
		door = { table, key, route, original };
		log("chat door installed (POST /dsh-pet-7340/chat → bridge, no upstream patch)");
		return true;
	}

	/**
	 * 启动竞态与「上游重注册」都在这两段里收掉：
	 * - 插件可能比 dsh-pet 先挂载（bundles 顺序不保证，插件多了加载更慢），此时路由还不存在；
	 * - dsh-pet 改配置/热重载时会 dispose 旧路由再注册新的，把我们的门房一起冲掉。
	 * 所以：重试不设上限（只在前 60 次后提示一次），另加看门狗每 3s 确认门房还在。
	 */
	function scheduleDoorRetry() {
		if (doorRetryTimer !== null) return;
		let attempts = 0;
		doorRetryTimer = setInterval(() => {
			attempts += 1;
			if (installChatDoor()) {
				clearInterval(doorRetryTimer);
				doorRetryTimer = null;
				return;
			}
			if (attempts === 60) {
				log("chat door still pending after 30s: pet route unavailable yet (native chat unaffected)");
			}
		}, 500);
		doorRetryTimer.unref?.();
	}

	if (!installChatDoor()) scheduleDoorRetry();

	const doorWatch = setInterval(() => {
		if (door === null) {
			// 还没装上就继续补
			installChatDoor();
			return;
		}
		const current = door.table.get(door.key);
		const alive = current !== undefined && current?.handler?.[DOOR_FLAG] === true;
		if (alive) return;
		// 门房被覆盖了（上游重注册/其它插件改写）：重新装一次，仍然以当前 handler 为原生兜底
		door = null;
		if (installChatDoor()) log("chat door re-installed (upstream re-registered the pet route)");
	}, 3000);
	doorWatch.unref?.();

	// ---- poll loop (TEST ENTRY) ----------------------------------------------
	function looksLikeCancel(filePath) {
		if (path.basename(filePath).startsWith("cancel")) return true;
		try {
			const stat = fs.statSync(filePath);
			if (!stat.isFile() || stat.size > MAX_REQ_FILE_BYTES) return false;
			const raw = fs.readFileSync(filePath, "utf8");
			const parsed = JSON.parse(raw);
			return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
				&& parsed.action === "cancel";
		} catch {
			return false;
		}
	}

	const poll = () => {
		try {
			let entries;
			try {
				entries = fs.readdirSync(reqDir);
			} catch {
				return;
			}
			const files = entries.filter((n) => n.endsWith(".json")).sort();
			for (const name2 of files) {
				if (!looksLikeCancel(path.join(reqDir, name2))) processRequestFile(path.join(reqDir, name2));
			}
			for (const name2 of files) {
				if (looksLikeCancel(path.join(reqDir, name2))) processRequestFile(path.join(reqDir, name2));
			}
		} catch (err) {
			log(`poll loop error: ${err?.stack ?? err}`);
		}
	};
	const pollTimer = setInterval(poll, POLL_MS);

	// ---- teardown ------------------------------------------------------------
	ctx.effect(() => () => {
		clearInterval(pollTimer);
		if (memRetryTimer !== null) clearInterval(memRetryTimer);
		if (doorRetryTimer !== null) clearInterval(doorRetryTimer);
		clearInterval(doorWatch);
		if (door !== null) {
			try {
				door.table.set(door.key, { ...door.route, handler: door.original });
			} catch { /* table 可能已随宿主销毁 */ }
			door = null;
		}
		for (const timer of timers.values()) clearTimeout(timer);
		timers.clear();
		activeBySession.clear();
		try { unregisterMemProvider?.(); } catch { /* ignore */ }
		offSessionEvent?.();
		log("disposed");
	}, `${PLUGIN_ID}.lifecycle`);

	log("task controller ready (chat commands: /task /memory /称呼 /bridge; request files remain a TEST ENTRY)");
}

export { apply, inject, name };

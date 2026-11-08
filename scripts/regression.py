# -*- coding: utf-8 -*-
"""桌面版全量回归：两个插件装好后，从聊天接口逐项断言。

用法：
    python regression.py            # 默认测本机 39190
环境变量：
    DSH_BRIDGE_BASE   桥接数据目录（默认 petlab 隔离目录）
    DSH_BRIDGE_TOKEN  写有 token 的文件路径（默认 research/env/current-token.txt）
    DSH_BRIDGE_HOST   默认 http://127.0.0.1:39190
"""
import hashlib
import json
import os
import re
import sys
import time
import urllib.error
import urllib.request

HOST = os.environ.get("DSH_BRIDGE_HOST", "http://127.0.0.1:39190")
BASE = os.environ.get(
    "DSH_BRIDGE_BASE",
    r"C:/Users/Administrator/WorkBuddy/2026-11-08-00-13-49/research/env/dsh-home/dsh-pet-task-ctl",
)
TOKEN_FILE = os.environ.get(
    "DSH_BRIDGE_TOKEN",
    r"C:/Users/Administrator/WorkBuddy/2026-11-08-00-13-49/research/env/current-token.txt",
)
DSH_PET_LIB = os.environ.get(
    "DSH_BRIDGE_PET_LIB",
    r"C:/Users/Administrator/WorkBuddy/2026-11-08-00-13-49/research/env/dsh-home/profiles/petlab/node_modules/dsh-pet/lib/index.js",
)
BASELINE_SHA = "19c5587b9508d1da70041f47c49f06c61b94351563c286b49b582d14739ef523"


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), _NoRedirect())

results = []


def check(name, ok, detail=""):
    results.append((name, bool(ok), detail))
    print(("  PASS  " if ok else "  FAIL  ") + name + ("" if ok else "   -> " + str(detail)[:300]))


def cookie():
    with open(TOKEN_FILE, encoding="utf-8") as f:
        token = f.read().strip()
    req = urllib.request.Request(f"{HOST}/?token={token}")
    try:
        resp = opener.open(req, timeout=10)
        raw = resp.headers.get("Set-Cookie", "")
    except urllib.error.HTTPError as e:
        raw = e.headers.get("Set-Cookie", "")
    pair = raw.split(";")[0]
    if "=" not in pair:
        # 桌面壳对本机回环免 token：返回空串，请求不带 Cookie 头
        return ""
    return pair


COOKIE = None


def chat(text, timeout=90):
    global COOKIE
    if COOKIE is None:
        COOKIE = cookie()
        if not COOKIE:
            print("  INFO  该实例免 token（本机回环），不发送 Cookie")
            COOKIE = "" 
    data = json.dumps({"text": text}, ensure_ascii=False).encode("utf-8")
    req = urllib.request.Request(
        f"{HOST}/dsh-pet-7340/chat?pet=main&surface=any",
        data=data,
        headers={"Content-Type": "application/json", **({"Cookie": COOKIE} if COOKIE else {})},
        method="POST",
    )
    body = opener.open(req, timeout=timeout).read().decode("utf-8", "replace")
    return json.loads(body)


def task_id_of(reply):
    m = re.search(r"#(chat-\d+-\d+)", json.dumps(reply, ensure_ascii=False))
    return m.group(1) if m else None


def wait_task(tid, max_s=300, poll=4):
    path = os.path.join(BASE, "results", f"task-{tid}.json")
    deadline = time.time() + max_s
    last = None
    while time.time() < deadline:
        try:
            with open(path, encoding="utf-8") as f:
                d = json.load(f)
            last = d.get("state")
            if last in ("completed", "failed", "cancelled"):
                return d
        except FileNotFoundError:
            pass
        time.sleep(poll)
    return {"state": last or "timeout"}


def main():
    ws = os.path.join(BASE, "workspaces", "pet-main")
    print(f"host={HOST}\nbase={BASE}\nws={ws}\n")

    # 0. 上游未被改动
    if os.path.exists(DSH_PET_LIB):
        h = hashlib.sha256(open(DSH_PET_LIB, "rb").read()).hexdigest()
        check("dsh-pet 未被修改（哈希=0.4.5 基线）", h == BASELINE_SHA, h)
    else:
        print("  SKIP  dsh-pet 路径不存在:", DSH_PET_LIB)

    # 1. 命令帮助
    r = chat("/bridge")
    txt = str(r.get("text", ""))
    check("/bridge 返回帮助", r.get("ok") is True and "/task" in txt and "/memory" in txt, txt[:200])

    # 2. 空任务状态
    r = chat("/task status")
    txt = str(r.get("text", ""))
    check("/task status 可用", r.get("ok") is True and ("还没有任务" in txt or "状态" in txt), txt[:200])

    # 3. 记忆列表
    r = chat("/memory list")
    txt = str(r.get("text", ""))
    check("/memory list 可用", r.get("ok") is True and "称呼" in txt, txt[:200])

    # 4. 设置称呼
    r = chat("/称呼 老板")
    txt = str(r.get("text", ""))
    check("/称呼 设置成功", r.get("ok") is True and "老板" in txt, txt[:200])

    # 5. 新增偏好
    mark = f"回归偏好-{int(time.time())}"
    r = chat(f"/memory add {mark}")
    txt = str(r.get("text", ""))
    check("/memory add 成功", r.get("ok") is True and ("记住" in txt or "已" in txt), txt[:200])

    # 6. 偏好落盘且聊天侧可见
    r = chat("/memory list")
    txt = str(r.get("text", ""))
    check("偏好已落盘并被读到", mark in txt, txt[:300])

    # 7. 原生聊天未被破坏
    r = chat("你好呀，简单回我一句就行")
    txt = str(r.get("text", ""))
    check("原生聊天正常（非命令走原流程）", r.get("ok") is True and txt.strip() != "" and "/task" not in txt[:20], txt[:200])

    # 8. 创建任务
    r = chat("/task 在工作区创建 reg.txt，内容为：reg-ok")
    tid = task_id_of(r)
    check("/task 受理并返回任务号", r.get("ok") is True and tid is not None, r)
    if tid:
        d = wait_task(tid)
        check("任务完成", d.get("state") == "completed", d.get("state"))
        p = os.path.join(ws, "reg.txt")
        ok = os.path.exists(p) and "reg-ok" in open(p, encoding="utf-8", errors="replace").read()
        check("文件真实落盘且内容正确", ok, p)

        # 9. 状态查询
        r = chat(f"/task status {tid}")
        txt = str(r.get("text", ""))
        check("/task status 反映完成态", "completed" in txt or "完成" in txt, txt[:200])

        # 10. 列表
        r = chat("/task list")
        txt = str(r.get("text", ""))
        check("/task list 含最新任务", tid in txt, txt[:200])

        # 11. 连续指令（会话复用）
        r = chat("/task 把 reg.txt 的内容改成：reg-ok-2")
        tid2 = task_id_of(r)
        check("连续任务被受理", r.get("ok") is True and tid2 is not None, r)
        if tid2:
            d2 = wait_task(tid2)
            check("连续任务完成", d2.get("state") == "completed", d2.get("state"))
            p = os.path.join(ws, "reg.txt")
            content = open(p, encoding="utf-8", errors="replace").read() if os.path.exists(p) else ""
            check("连续指令改写生效", "reg-ok-2" in content, content[:200])

    # 12. 取消
    r = chat("/task 在工作区创建 cancel-me.txt，然后逐行写入 3000 行占位文本，写完再回读校验")
    tid3 = task_id_of(r)
    check("长任务被受理（用于取消）", r.get("ok") is True and tid3 is not None, r)
    if tid3:
        time.sleep(2)
        r = chat("/task cancel")
        txt = str(r.get("text", ""))
        check("取消被受理", r.get("ok") is True and ("取消" in txt), txt[:200])
        d3 = wait_task(tid3, max_s=240)
        check("任务进入 cancelled", d3.get("state") == "cancelled", d3.get("state"))

    # 13. 记忆文件存在
    mem = os.path.join(BASE, "pet-memory.json")
    check("宠物记忆文件存在", os.path.exists(mem), mem)
    if os.path.exists(mem):
        data = json.load(open(mem, encoding="utf-8"))
        slot = data.get("pets", {}).get("main", {})
        check("称呼已持久化", slot.get("ownerName") == "老板", slot.get("ownerName"))
        check("偏好已持久化", any(mark in str(p) for p in slot.get("prefs", [])), slot.get("prefs"))

    passed = sum(1 for _, ok, _ in results if ok)
    total = len(results)
    print(f"\n=== {passed}/{total} 通过 ===")
    if passed != total:
        print("失败项：")
        for n, ok, d in results:
            if not ok:
                print(" -", n, "->", str(d)[:200])
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())

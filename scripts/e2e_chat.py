# -*- coding: utf-8 -*-
"""E2E chat helper for dsh-pet Agent Bridge.

Talks to the dsh-pet chat endpoint of a running DSH host, so you can exercise
the bridge from a script instead of clicking the panel.

Env vars (all optional, sensible defaults):
  DSH_HOST          http://127.0.0.1:39190
  DSH_TOKEN         web token from the host's "dsh web: ...?token=" line
                    (alternatively drop it in DSH_TOKEN_FILE)
  DSH_TOKEN_FILE    file containing the token
  DSH_HOME          DSH home dir; used to locate results/ for --wait polling

Usage:
  python e2e_chat.py "task 在工作区创建 hello.txt"          # sends "/task ..."
  python e2e_chat.py --raw "/bridge"                        # sends as-is
  python e2e_chat.py --wait --max 600 "task 建 8 个文件"     # poll until terminal

Notes (windows/agent quirks this script already handles):
  * bypasses the system proxy (otherwise localhost can return 502)
  * does NOT follow the token->cookie 302 redirect, because urllib drops
    Set-Cookie on redirect; the fence's cookie is on the 302 response itself
"""
import json
import os
import sys
import time
import urllib.request
import urllib.error

HOST = os.environ.get("DSH_HOST", "http://127.0.0.1:39190")
TOKEN = os.environ.get("DSH_TOKEN", "")
TOKEN_FILE = os.environ.get("DSH_TOKEN_FILE", "")
DSH_HOME = os.environ.get("DSH_HOME", os.path.expanduser("~/.dsh"))
RESULTS = os.path.join(DSH_HOME, "dsh-pet-task-ctl", "results")


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), _NoRedirect())


def get_cookie():
    token = TOKEN
    if not token and TOKEN_FILE:
        with open(TOKEN_FILE, encoding="utf-8") as f:
            token = f.read().strip()
    if not token:
        raise SystemExit("no token: set DSH_TOKEN or DSH_TOKEN_FILE")
    req = urllib.request.Request(f"{HOST}/?token={token}")
    try:
        resp = opener.open(req, timeout=10)
        cookie = resp.headers.get("Set-Cookie", "")
    except urllib.error.HTTPError as e:  # 302/401 both still carry headers
        cookie = e.headers.get("Set-Cookie", "")
    pair = cookie.split(";")[0]
    if "=" not in pair:
        raise SystemExit("token fence returned no cookie (token expired?)")
    return pair


def chat(text, timeout=90):
    cookie = get_cookie()
    data = json.dumps({"text": text}, ensure_ascii=False).encode("utf-8")
    req = urllib.request.Request(
        f"{HOST}/dsh-pet-7340/chat?pet=main&surface=any",
        data=data,
        headers={"Content-Type": "application/json", "Cookie": cookie},
        method="POST",
    )
    return opener.open(req, timeout=timeout).read().decode("utf-8", "replace")


def latest_task_id(reply):
    # reply carries 已收到任务 #chat-<ts>-<n>
    i = reply.find("#chat-")
    if i < 0:
        return None
    tail = reply[i + 1:]
    out = []
    for ch in tail:
        if ch.isalnum() or ch in "-_":
            out.append(ch)
        else:
            break
    return "".join(out) or None


def wait_task(task_id, max_s=600, poll=5):
    path = os.path.join(RESULTS, f"task-{task_id}.json")
    deadline = time.time() + max_s
    last = None
    while time.time() < deadline:
        try:
            with open(path, encoding="utf-8") as f:
                d = json.load(f)
            if d.get("state") != last:
                last = d.get("state")
                print(f"  [{time.strftime('%H:%M:%S')}] state={last}")
            if last in ("completed", "failed", "cancelled"):
                return d
        except FileNotFoundError:
            pass
        time.sleep(poll)
    return {"state": "timeout"}


def main():
    argv = sys.argv[1:]
    want_wait = False
    raw = False
    max_s = 600
    if "--wait" in argv:
        want_wait = True
        argv.remove("--wait")
    if "--raw" in argv:
        raw = True
        argv.remove("--raw")
    if "--max" in argv:
        i = argv.index("--max")
        max_s = int(argv[i + 1])
        del argv[i:i + 2]
    if not argv:
        raise SystemExit(__doc__)
    text = " ".join(argv)
    if not raw:
        text = "/" + text
    out = chat(text)
    print("REPLY:", out[:1000])
    if want_wait:
        tid = latest_task_id(out)
        if not tid:
            print("no task id in reply; nothing to poll")
            return
        print(f"waiting for {tid} ...")
        d = wait_task(tid, max_s)
        print("FINAL:", d.get("state"))
        print("RESULT:", str(d.get("resultText"))[:2000])
        if d.get("error"):
            print("ERROR:", str(d.get("error"))[:600])


if __name__ == "__main__":
    main()

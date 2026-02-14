#!/usr/bin/env python3
"""
测试 Codex app-server JSON-RPC 协议（非 HTTP messages[{role,content}]）。

协议要点：
- 请求: { "id": 1, "method": "turn/start", "params": { "threadId": "xxx", "input": [{ "type": "text", "text": "你好" }] } }
- 响应: { "id": 1, "result": { ... } }
- 通知: { "method": "item/agentMessage/delta", "params": { "delta": "...", "itemId", "threadId", "turnId" } }

流程：thread/start -> 取 thread.id -> turn/start(threadId, input) -> 收 item/agentMessage/delta 与 turn/completed。
多轮：同一 threadId 再次 turn/start。

传输：默认 stdio（逐行 JSON），可配置为子进程命令，例如 codex app-server 或 npx codex --stdio。
"""
import json
import os
import subprocess
import sys
import threading

# 默认 "codex app-server"（或本机实际命令）；用 CODEX_APP_SERVER_CMD 覆盖
APP_SERVER_CMD = (os.environ.get("CODEX_APP_SERVER_CMD") or "codex app-server").strip()


def send_request(proc, req: dict) -> None:
    line = json.dumps(req, ensure_ascii=False) + "\n"
    proc.stdin.write(line)
    proc.stdin.flush()


def read_response(recv_queue: list) -> dict | None:
    while recv_queue:
        msg = recv_queue.pop(0)
        if "result" in msg or "error" in msg:
            return msg
    return None


def run_stdio_test(cmd: list):
    # 先处理 dump，确保一定执行（PowerShell 请用 $env:CODEX_APP_SERVER_DUMP="1"）
    dump_file = os.environ.get("CODEX_APP_SERVER_DUMP")
    if dump_file:
        dump_file = dump_file.strip()
        if dump_file in ("1", "true", "yes"):
            dump_file = os.path.join(os.path.dirname(os.path.abspath(__file__)), "dump.jsonl")
        else:
            dump_file = os.path.abspath(dump_file)
        print("Dumping messages to:", dump_file, flush=True)
        try:
            with open(dump_file, "w", encoding="utf-8") as f:
                f.write("")
        except Exception as e:
            print("Dump file create failed:", e, flush=True)
            dump_file = None
    else:
        dump_file = None

    # Windows 下用 shell=True 才能从 PATH 找到 codex
    use_shell = sys.platform == "win32"
    proc = subprocess.Popen(
        cmd if not use_shell else " ".join(cmd),
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        bufsize=1,
        shell=use_shell,
    )
    recv_queue = []

    def _dump(msg):
        if not dump_file:
            return
        try:
            s = json.dumps(msg, ensure_ascii=False)
            if len(s) > 2000:
                s = s[:2000] + '..." (truncated)'
            with open(dump_file, "a", encoding="utf-8") as f:
                f.write(s + "\n")
        except Exception as e:
            print("Dump write error:", e, flush=True)

    def read_stdout():
        for line in proc.stdout:
            line = line.rstrip()
            if not line:
                continue
            try:
                msg = json.loads(line)
                recv_queue.append(msg)
            except json.JSONDecodeError:
                pass

    t = threading.Thread(target=read_stdout, daemon=True)
    t.start()

    import time

    def wait_for(id_val, timeout_sec=5):
        for _ in range(int(timeout_sec * 10)):
            time.sleep(0.1)
            for i in range(len(recv_queue)):
                if recv_queue[i].get("id") == id_val:
                    msg = recv_queue[i]
                    del recv_queue[i]
                    return msg
        return None

    # 1) initialize（后端要求先初始化）
    send_request(
        proc,
        {
            "id": 0,
            "method": "initialize",
            "params": {"clientInfo": {"name": "test-app-server-rpc", "version": "0.1.0"}},
        },
    )
    init_res = wait_for(0)
    if not init_res or "result" not in init_res:
        print("timeout or error waiting for initialize:", init_res or recv_queue)
        proc.terminate()
        return

    # 2) thread/start
    send_request(proc, {"id": 1, "method": "thread/start", "params": {}})
    res = wait_for(1)
    if not res or "result" not in res:
        print("timeout or error waiting for thread/start:", res or recv_queue)
        proc.terminate()
        return
    thread_id = res["result"].get("thread", {}).get("id")
    if not thread_id:
        print("no thread.id in thread/start result:", res)
        proc.terminate()
        return
    print("threadId:", thread_id)

    # 3) turn/start
    send_request(
        proc,
        {
            "id": 2,
            "method": "turn/start",
            "params": {
                "threadId": thread_id,
                "input": [{"type": "text", "text": "只说一句话：你好"}],
            },
        },
    )
    full_text = []
    completed_text = None
    turn_done = False
    seen_methods = set()
    turn_related = ("item/agentMessage/delta", "item/completed", "turn/completed", "turn/started")
    debug = os.environ.get("CODEX_APP_SERVER_DEBUG", "").lower() in ("1", "true", "yes")
    timeout_sec = int(os.environ.get("CODEX_APP_SERVER_TIMEOUT", "60"))
    timeout_loops = timeout_sec * 10

    for _ in range(timeout_loops):
        time.sleep(0.1)
        done_idx = []
        for i, m in enumerate(recv_queue):
            if dump_file:
                _dump(m)
            method = m.get("method")
            if method:
                if method in turn_related or method.startswith("item/") or method.startswith("turn/"):
                    seen_methods.add(method)
                if debug:
                    print("[debug]", method, flush=True)
            if method == "item/agentMessage/delta":
                full_text.append(m.get("params", {}).get("delta", ""))
                done_idx.append(i)
            elif method == "item/completed":
                item = m.get("params", {}).get("item", {})
                if item.get("type") == "agentMessage" and item.get("text"):
                    completed_text = item.get("text", "")
                done_idx.append(i)
            elif method == "turn/completed":
                turn_done = True
                done_idx.append(i)
            elif m.get("id") == 2:
                if debug and "result" in m:
                    print("[debug] turn/start result:", m.get("result"), flush=True)
                done_idx.append(i)
        for i in reversed(done_idx):
            del recv_queue[i]
        if turn_done:
            break
    proc.terminate()
    reply = "".join(full_text) or (completed_text or "")
    print("reply (streamed):", reply or "(empty)")
    if not reply and seen_methods:
        print("received (turn-related) methods:", ", ".join(sorted(seen_methods)))
    if not turn_done and not reply:
        print("(no turn/completed in {}s – model may be slow or backend uses different notification names)".format(timeout_loops / 10))
        print("(set CODEX_APP_SERVER_DUMP=dump.jsonl and run again to capture raw messages, then inspect for 'turn' or 'item')")
    print("ok")


def main():
    if not APP_SERVER_CMD:
        print("Usage: set CODEX_APP_SERVER_CMD to the app-server command, e.g.:")
        print('  set CODEX_APP_SERVER_CMD=codex app-server')
        sys.exit(1)
    print("Using command:", APP_SERVER_CMD)
    dump_env = os.environ.get("CODEX_APP_SERVER_DUMP", "(not set)")
    print("CODEX_APP_SERVER_DUMP=%s" % dump_env, flush=True)
    cmd = APP_SERVER_CMD.split()
    run_stdio_test(cmd)


if __name__ == "__main__":
    main()

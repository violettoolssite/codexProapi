#!/usr/bin/env python3
"""多发几次聊天请求，观察 /api/usage 额度变化。需先启动服务。"""
import os
import sys
import urllib.request
import json

BASE_URL = os.environ.get("CODEX_PROAPI_URL", "http://localhost:1455")
MODEL = "gpt-5.3-codex"
NUM_CHATS = 5  # 连续请求次数

def get_usage():
    req = urllib.request.Request(BASE_URL + "/api/usage")
    with urllib.request.urlopen(req, timeout=10) as r:
        return json.loads(r.read().decode())

def chat_once(content, stream=False):
    try:
        from openai import OpenAI
    except ImportError:
        print("请安装: pip install openai")
        sys.exit(1)
    client = OpenAI(base_url=BASE_URL + "/v1", api_key="codex-proapi")
    r = client.chat.completions.create(
        model=MODEL,
        messages=[{"role": "user", "content": content}],
        stream=stream,
    )
    if stream:
        for chunk in r:
            if chunk.choices and chunk.choices[0].delta.content:
                pass  # 消费流
        return True
    return (r.choices[0].message.content or "")[:80]

def main():
    print("Base URL:", BASE_URL)
    print("当前额度 (GET /api/usage):")
    try:
        before = get_usage()
        for i, acc in enumerate(before.get("accounts", [])):
            pct = acc.get("remaining_pct")
            used = acc.get("used_tokens")
            quota = acc.get("quota_tokens")
            pct_s = f"剩余 {pct}%" if pct is not None else "N/A"
            used_s = f"已用 {used} token" if used is not None else ""
            quota_s = f"/ {quota}" if quota is not None else ""
            print(f"  账号 {i}: {pct_s}  {used_s}{quota_s}")
    except Exception as e:
        print("  请求失败:", e)
        print("请先启动服务: npm start")
        sys.exit(1)

    print(f"\n连续发送 {NUM_CHATS} 次聊天请求...")
    for i in range(NUM_CHATS):
        msg = f"第{i+1}次测试，请简短回复一句。"
        try:
            out = chat_once(msg, stream=(i % 2 == 0))
            print(f"  [{i+1}/{NUM_CHATS}] 请求完成" + (f" 回复预览: {out[:40]}..." if isinstance(out, str) and out else ""))
        except Exception as e:
            print(f"  [{i+1}/{NUM_CHATS}] 失败:", e)

    print("\n当前额度 (GET /api/usage):")
    try:
        after = get_usage()
        for i, acc in enumerate(after.get("accounts", [])):
            pct = acc.get("remaining_pct")
            used = acc.get("used_tokens")
            quota = acc.get("quota_tokens")
            pct_s = f"剩余 {pct}%" if pct is not None else "N/A"
            used_s = f"已用 {used} token" if used is not None else ""
            quota_s = f"/ {quota}" if quota is not None else ""
            print(f"  账号 {i}: {pct_s}  {used_s}{quota_s}")
    except Exception as e:
        print("  请求失败:", e)
    print("\n完成。可在模型页刷新查看额度条。")

if __name__ == "__main__":
    main()

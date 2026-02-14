#!/usr/bin/env python3
"""
测试 Codex Pro API：单轮、多轮对话，以及图片理解（可选）。
需先启动服务：npm start 或 codex-proapi
默认 base_url: http://localhost:1455
"""
import json
import os
import subprocess
import sys

# 优先使用 openai 包（兼容 OpenAI 接口）
try:
    from openai import OpenAI
    HAS_OPENAI = True
except ImportError:
    HAS_OPENAI = False

BASE_URL = os.environ.get("CODEX_PROAPI_URL", "http://localhost:1455")
MODEL = "gpt-5.3-codex"

# 客户端工具执行器（OpenAI 标准：客户端收到 tool_calls 后自行执行）
def execute_tool(name, arguments):
    """在测试脚本内执行工具，返回 JSON 字符串。支持 get_weather、run_terminal_cmd / run_command 等。"""
    args = arguments if isinstance(arguments, dict) else {}
    try:
        if isinstance(arguments, str):
            args = json.loads(arguments) if arguments.strip() else {}
    except Exception:
        args = {}
    if name == "get_weather":
        city = args.get("city", "北京")
        try:
            import urllib.request
            import urllib.error
            city_enc = urllib.request.quote(str(city))
            geo_url = f"https://geocoding-api.open-meteo.com/v1/search?name={city_enc}&count=1"
            with urllib.request.urlopen(geo_url, timeout=10) as r:
                geo = json.loads(r.read().decode())
            results = geo.get("results") or []
            if not results and city in ("北京", "北京市"):
                geo_url = "https://geocoding-api.open-meteo.com/v1/search?name=Beijing&count=1"
                with urllib.request.urlopen(geo_url, timeout=10) as r:
                    geo = json.loads(r.read().decode())
                results = geo.get("results") or []
            if not results:
                return json.dumps({"city": city, "error": "未找到该城市"}, ensure_ascii=False)
            lat, lon = results[0]["latitude"], results[0]["longitude"]
            name_ret = results[0].get("name", city)
            weather_url = f"https://api.open-meteo.com/v1/forecast?latitude={lat}&longitude={lon}&current_weather=true"
            with urllib.request.urlopen(weather_url, timeout=10) as r:
                w = json.loads(r.read().decode())
            cw = w.get("current_weather", {})
            temp = cw.get("temperature")
            code = cw.get("weathercode", 0)
            desc_map = {0: "晴", 1: "大部晴朗", 2: "少云", 3: "多云", 61: "雨", 80: "阵雨"}
            condition = desc_map.get(code, f"天气码{code}")
            desc = f"{name_ret}当前{condition}，气温 {temp}°C。" if temp is not None else f"{name_ret}：{condition}"
            return json.dumps({"city": name_ret, "temp": temp, "condition": condition, "desc": desc}, ensure_ascii=False)
        except Exception as e:
            return json.dumps({"city": city, "error": str(e)}, ensure_ascii=False)
    if name in ("run_terminal_cmd", "run_command", "run_command_line", "execute_command", "ls"):
        cmd = args.get("command") or args.get("cmd") or (["ls"] if name == "ls" else "")
        if isinstance(cmd, list):
            cmd = " ".join(str(x) for x in cmd)
        cmd = str(cmd).strip() or "ls"
        try:
            out = subprocess.run(
                cmd,
                shell=True,
                capture_output=True,
                text=True,
                timeout=15,
            )
            return json.dumps({"stdout": out.stdout or "", "stderr": out.stderr or "", "returncode": out.returncode})
        except subprocess.TimeoutExpired:
            return json.dumps({"error": "command timeout", "stdout": "", "stderr": ""})
        except Exception as e:
            return json.dumps({"error": str(e), "stdout": "", "stderr": ""})
    return json.dumps({"error": f"unknown tool: {name}"})


def test_single_turn():
    """单轮对话"""
    print("=== 单轮对话 ===")
    client = OpenAI(base_url=BASE_URL + "/v1", api_key="codex-proapi")
    r = client.chat.completions.create(
        model=MODEL,
        messages=[{"role": "user", "content": "只说一句话：你好，我是 Codex。"}],
    )
    text = r.choices[0].message.content
    print("回复:", text)
    print()
    return text


def test_multi_turn():
    """多轮对话"""
    print("=== 多轮对话 ===")
    client = OpenAI(base_url=BASE_URL + "/v1", api_key="codex-proapi")
    r = client.chat.completions.create(
        model=MODEL,
        messages=[
            {"role": "user", "content": "记住这个数字：42"},
            {"role": "assistant", "content": "好的，我记住了数字 42。"},
            {"role": "user", "content": "我刚刚让你记住的数字是多少？只回答数字。"},
        ],
    )
    text = r.choices[0].message.content
    print("回复:", text)
    print()
    return text


def test_stream():
    """流式输出"""
    print("=== 流式输出 ===")
    client = OpenAI(base_url=BASE_URL + "/v1", api_key="codex-proapi")
    stream = client.chat.completions.create(
        model=MODEL,
        messages=[{"role": "user", "content": "数到 5，每行一个数字。"}],
        stream=True,
    )
    print("回复(流式): ", end="", flush=True)
    for chunk in stream:
        if chunk.choices and chunk.choices[0].delta.content:
            print(chunk.choices[0].delta.content, end="", flush=True)
    print("\n")
    return True


def test_tool_calls():
    """工具调用：OpenAI 标准格式，请求带 tools，检查响应是否包含 tool_calls（代理仅转发）"""
    print("=== 工具调用 ===")
    client = OpenAI(base_url=BASE_URL + "/v1", api_key="codex-proapi")
    tools = _tools_openai_standard()
    r = client.chat.completions.create(
        model=MODEL,
        messages=[{"role": "user", "content": "北京今天天气怎么样？请调用 get_weather 工具，city 填北京。"}],
        tools=tools,
        tool_choice="auto",
    )
    msg = r.choices[0].message
    content = getattr(msg, "content", None) or ""
    tool_calls = getattr(msg, "tool_calls", None) or []
    print("message.content:", repr(content)[:200])
    print("message.tool_calls:", len(tool_calls), "个")
    if tool_calls:
        for i, tc in enumerate(tool_calls):
            name = getattr(tc.function, "name", None) if hasattr(tc, "function") else None
            args = getattr(tc.function, "arguments", None) if hasattr(tc, "function") else None
            print("  [%d] name=%s arguments=%s" % (i, name, repr(args)[:100]))
    else:
        print("  (无 tool_calls)")
    print()
    return tool_calls


def _tools_openai_standard():
    """OpenAI 标准格式的 tools：get_weather + run_terminal_cmd（Codex 可执行 ls 等命令）"""
    return [
        {
            "type": "function",
            "function": {
                "name": "get_weather",
                "description": "Get the current weather in a given city.",
                "parameters": {
                    "type": "object",
                    "properties": {"city": {"type": "string", "description": "City name"}},
                    "required": ["city"],
                },
            },
        },
        {
            "type": "function",
            "function": {
                "name": "run_terminal_cmd",
                "description": "Run a terminal/shell command (e.g. ls, pwd) and return stdout/stderr.",
                "parameters": {
                    "type": "object",
                    "properties": {"command": {"type": "string", "description": "Shell command to run"}},
                    "required": ["command"],
                },
            },
        },
    ]


def test_tool_calls_with_text_reply():
    """工具调用 + 文本回复：客户端按 OpenAI 标准执行 tool_calls 并续传，直到拿到最终文字（支持 get_weather、ls 等）"""
    print("=== 工具调用（客户端执行工具，要有文本回复）===")
    client = OpenAI(base_url=BASE_URL + "/v1", api_key="codex-proapi")
    tools = _tools_openai_standard()
    messages = [{"role": "user", "content": "北京今天天气如何？请用 get_weather 查北京并给我一句话回复。"}]
    max_rounds = 6
    for _ in range(max_rounds):
        r = client.chat.completions.create(model=MODEL, messages=messages, tools=tools, tool_choice="auto")
        msg = r.choices[0].message
        content = (getattr(msg, "content", None) or "").strip()
        tool_calls = getattr(msg, "tool_calls", None) or []
        if not tool_calls:
            print("回复:", content or "(无文本)")
            print()
            return content
        messages.append(
            {
                "role": "assistant",
                "content": content or None,
                "tool_calls": [
                    {"id": tc.id, "type": getattr(tc, "type", "function"), "function": {"name": tc.function.name, "arguments": tc.function.arguments or "{}"}}
                    for tc in tool_calls
                ],
            }
        )
        for tc in tool_calls:
            name = tc.function.name
            args_str = tc.function.arguments or "{}"
            try:
                args = json.loads(args_str)
            except Exception:
                args = {}
            result = execute_tool(name, args)
            messages.append({"role": "tool", "tool_call_id": tc.id, "content": result})
    print("回复:", "(已达最大轮数，未得到最终文字)")
    print()
    return None


def test_tool_calls_ls():
    """工具调用（ls）：客户端执行 run_terminal_cmd / ls，验证 Codex 能正常触发命令类工具并得到文本回复"""
    print("=== 工具调用（ls / 命令执行）===")
    client = OpenAI(base_url=BASE_URL + "/v1", api_key="codex-proapi")
    tools = _tools_openai_standard()
    messages = [{"role": "user", "content": "请执行 ls 命令，看一下当前目录有哪些文件，用一句话总结。"}]
    max_rounds = 6
    for _ in range(max_rounds):
        r = client.chat.completions.create(model=MODEL, messages=messages, tools=tools, tool_choice="auto")
        msg = r.choices[0].message
        content = (getattr(msg, "content", None) or "").strip()
        tool_calls = getattr(msg, "tool_calls", None) or []
        if not tool_calls:
            print("回复:", content or "(无文本)")
            print()
            return content
        messages.append(
            {
                "role": "assistant",
                "content": content or None,
                "tool_calls": [
                    {"id": tc.id, "type": getattr(tc, "type", "function"), "function": {"name": tc.function.name, "arguments": tc.function.arguments or "{}"}}
                    for tc in tool_calls
                ],
            }
        )
        for tc in tool_calls:
            name = tc.function.name
            args_str = tc.function.arguments or "{}"
            try:
                args = json.loads(args_str)
            except Exception:
                args = {}
            result = execute_tool(name, args)
            messages.append({"role": "tool", "tool_call_id": tc.id, "content": result})
    print("回复:", "(已达最大轮数)")
    print()
    return None


def test_image_vision(image_url: str):
    """图片理解（需要带 vision 的模型）"""
    print("=== 图片理解 ===")
    client = OpenAI(base_url=BASE_URL + "/v1", api_key="codex-proapi")
    r = client.chat.completions.create(
        model=MODEL,
        messages=[
            {
                "role": "user",
                "content": [
                    {"type": "text", "text": "请用一句话描述这张图片的内容。"},
                    {"type": "image_url", "image_url": {"url": image_url}},
                ],
            }
        ],
    )
    text = r.choices[0].message.content
    print("回复:", text)
    print()
    return text


def main():
    print(f"Base URL: {BASE_URL}\n")
    if not HAS_OPENAI:
        print("请安装: pip install openai")
        sys.exit(1)

    try:
        test_single_turn()
        test_multi_turn()
        test_stream()
        test_tool_calls()
        test_tool_calls_with_text_reply()
        test_tool_calls_ls()
    except Exception as e:
        err = str(e).lower()
        if "connection" in err or "refused" in err or "10061" in err:
            print("连接失败：请先启动 Codex Pro API（npm start 或 codex-proapi）")
        raise

    # 可选：传入图片 URL 测试 vision
    img = "https://ts1.tc.mm.bing.net/th?id=ORMS.2f0cd4a55305fbf7d4cfd83caf20af6d&pid=Wdp&w=268&h=140&qlt=90&c=1&rs=1&dpr=1&p=0"
    if img:
        test_image_vision(img)
    else:
        print("跳过图片测试（设置 TEST_IMAGE_URL 可测，例如：export TEST_IMAGE_URL='https://...'）")


if __name__ == "__main__":
    main()

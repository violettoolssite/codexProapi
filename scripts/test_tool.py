from openai import OpenAI

client = OpenAI(api_key="codex-proapi", base_url="http://localhost:1455/v1")

tools = [{
"type": "function",
"name": "get_weather",
"description": "获取指定城市的当前天气",
"parameters": {
"type": "object",
"properties": {
"location": {"type": "string", "description": "城市名称，如'北京'"}
},
"required": ["location"]
}
}]

response = client.responses.create(
   model="gpt-5.3-codex",
   input=[{"role": "user", "content": "北京天气怎么样"}],
   tools=tools,
   tool_choice="auto"
)
tool_call = response.output[0]

import json, requests
def get_weather(location):
   r = requests.get("https://api.seniverse.com/v3/weather/now.json",
                    params={"key": "your-key", "location": location, "language": "zh-Hans"})
   data = r.json()
   now = data["results"][0]["now"]
   return f"{location}当前天气：{now['text']}，气温{now['temperature']}°C"
args = json.loads(tool_call.arguments)
result = get_weather(args["location"])
final_response = client.responses.create(
   model="gpt-5.3-codex",
   input=[
       {"role": "user", "content": "北京天气怎么样"},
       tool_call,
       {"type": "function_call_output", "call_id": tool_call.call_id, "output": json.dumps(result)}
   ],
   tools=tools
)
print(final_response.output_text)
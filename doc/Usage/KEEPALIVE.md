# 功能介绍: 伪流式模型

## Docker/Hugging Face Space/Node.js

在网页设置中开启 `伪流式模型` 开关后，模型列表会额外显示带 `-pseudo-stream` 后缀的模型。

例如原始模型为 `gemini-2.5-flash`，开启后会额外显示：

```text
gemini-2.5-flash-pseudo-stream
```

如果同时开启 `联网搜索`，搜索模型也会生成对应的伪流式版本：

```text
gemini-2.5-flash-search-pseudo-stream
```

## 行为说明

- 普通模型的 `stream: true` 请求会保持上游 Gemini/Vertex 的原生流式响应。
- 只有请求带 `-pseudo-stream` 后缀的模型，并且客户端传入 `stream: true` 时，才会使用伪流式。
- 伪流式实际会向上游发起一次非流式请求，等待完整结果返回后，再包装成 OpenAI SSE 响应并发送 `[DONE]`。
- 伪流式会保留项目的密钥轮换和重试机制，适合需要 `stream: true` 接口形态、但不需要真正逐 token 输出的客户端。

该功能不再发送旧版心跳，也不再要求关闭 Worker API Key 的安全设置。

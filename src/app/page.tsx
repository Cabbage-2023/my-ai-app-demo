'use client';

import { useChat } from '@ai-sdk/react';
import { useState } from 'react';

export default function Chat() {
  const [input, setInput] = useState('');
  const { messages, sendMessage } = useChat();
  return (
    <div className="flex flex-col w-full max-w-md py-24 mx-auto stretch">
      {messages.map(message => (
        <div key={message.id} className="whitespace-pre-wrap">
          {message.role === 'user' ? 'User: ' : 'AI: '}
          {message.parts.map((part:any, i) => {
            switch (part.type) {
              case 'text':
                return <div key={`${message.id}-${i}`} className="whitespace-pre-wrap">{part.text}</div>;

              // 处理天气工具
              case 'tool-weather': {
                // 【逻辑修复】：检查后面是否跟着一个“转换工具”的结果
                // 如果后面有 tool-convertFahrenheitToCelsius，我们就把这个原始框框变小，或者返回 null
                const isIntermediate = message.parts.some(
                  (p, index) => index > i && p.type === 'tool-convertFahrenheitToCelsius'
                );

                if (part.state === 'output-available') {
                  if (isIntermediate) {
                    // 如果是中间过程，只显示一行小字，或者干脆 return null 隐藏它
                    return <div key={`${message.id}-${i}`} className="text-xs text-gray-400 italic">已获取原始气象数据...</div>;
                  }

                  return (
                    <div key={`${message.id}-${i}`} className="p-3 my-2 bg-black-50 rounded-lg border border-blue-200">
                      📍 城市：{part.output.location} | 🌡️ {part.output.temperature}°F
                    </div>
                  );
                }
                return <div key={`${message.id}-${i}`} className="animate-pulse text-zinc-400">正在调取气象站...</div>;
              }

              // 处理转换工具
              case 'tool-convertFahrenheitToCelsius': {
                if (part.state === 'output-available') {
                  return (
                    <div key={`${message.id}-${i}`} className="p-3 my-2 bg-black-50 rounded-lg border border-white-200 shadow-sm">
                      <span className="font-bold">✅ 最终换算结果：</span>
                      <span className="text-xl text-white-600">{part.output.celsius}°C</span>
                    </div>
                  );
                }
                return null; // 转换过程非常快，通常不需要显示加载态
              }

              // --- 以下是 RAG 知识库 tool 渲染 ---
              // tool-addResource — 显示"已记住"的绿色提示
              case 'tool-addResource': {
                if (part.state === 'output-available') {
                  return (
                    <div key={`${message.id}-${i}`} className="p-2 my-1 text-xs text-green-500 italic">
                      📝 已记住一条新信息
                    </div>
                  );
                }
                return <div key={`${message.id}-${i}`} className="animate-pulse text-zinc-400">正在存入知识库...</div>;
              }

              //tool-getInformation — 展示检索结果列表，没找到时也有空状态提示
              case 'tool-getInformation': {
                if (part.state === 'output-available') {
                  const results = part.output;
                  if (!results || results.length === 0) {
                    return (
                      <div key={`${message.id}-${i}`} className="p-3 my-2 bg-yellow-50 rounded-lg border border-yellow-200">
                        ⚠️ 知识库中未找到相关信息
                      </div>
                    );
                  }
                  return (
                    <div key={`${message.id}-${i}`} className="p-3 my-2 bg-purple-50 rounded-lg border border-purple-200">
                      <div className="font-bold mb-1">📖 从知识库中找到 {results.length} 条相关信息：</div>
                      {results.map((r: any, j: number) => (
                        <div key={j} className="mb-2 pb-2 border-b border-purple-100 last:border-0">
                          <div>{r.content}</div>
                          {r.metadata?.name && (
                            <div className="text-xs text-gray-400 mt-1">来源：{r.metadata.name}</div>
                          )}
                        </div>
                      ))}
                    </div>
                  );
                }
                return <div key={`${message.id}-${i}`} className="animate-pulsetext-zinc-400">正在检索知识库...</div>;
              }
            }
          })}
        </div>
      ))}

      <form
        onSubmit={e => {
          e.preventDefault();
          sendMessage({ text: input });
          setInput('');
        }}
      >
        <input
          className="fixed dark:bg-zinc-900 bottom-0 w-full max-w-md p-2 mb-8 border border-zinc-300 dark:border-zinc-800 rounded shadow-xl"
          value={input}
          placeholder="Say something..."
          onChange={e => setInput(e.currentTarget.value)}
        />
      </form>
    </div>
  );
}
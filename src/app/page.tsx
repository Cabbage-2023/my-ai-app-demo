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
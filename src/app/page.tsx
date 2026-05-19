'use client';

import { useChat } from '@ai-sdk/react';
import { useState, useRef, useEffect, useSyncExternalStore } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

/** 从 <html> 的 class 中读取暗色模式状态（服务端返回 false） */
function useDarkMode(): boolean {
  return useSyncExternalStore(
    (onStoreChange) => {
      const observer = new MutationObserver(onStoreChange);
      observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
      return () => observer.disconnect();
    },
    () => document.documentElement.classList.contains('dark'),
    () => false,
  );
}

export default function Chat() {
  const [input, setInput] = useState('');
  const isDark = useDarkMode();
  const { messages, sendMessage, status, stop } = useChat();
  const isLoading = status === 'submitted' || status === 'streaming';
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  /* ── 暗色模式：从 localStorage 初始化 ── */
  useEffect(() => {
    const stored = localStorage.getItem('theme');
    const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    if (stored === 'dark' || (!stored && prefersDark)) {
      document.documentElement.classList.add('dark');
    }
  }, []);

  const toggleTheme = () => {
    const html = document.documentElement;
    html.classList.toggle('dark');
    localStorage.setItem('theme', html.classList.contains('dark') ? 'dark' : 'light');
  };

  const handleSend = () => {
    if (!input.trim() || isLoading) return;
    sendMessage({ text: input });
    setInput('');
  };

  return (
    <div className="flex flex-col h-dvh bg-subtle transition-colors">
      {/* Header */}
      <header className="bg-surface/80 backdrop-blur-sm border-b border-miku/15 px-4 py-3 sticky top-0 z-10 transition-colors">
        <div className="max-w-3xl mx-auto flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-full bg-gradient-to-br from-miku to-miku-dark flex items-center justify-center shadow-sm">
              <svg className="w-5 h-5 text-white" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5"/>
              </svg>
            </div>
            <div>
              <h1 className="text-base font-semibold text-fg">Galgame 知识库</h1>
              <p className="text-xs text-fg-muted hidden sm:block">基于真实玩家评价的 AI 助手</p>
            </div>
          </div>

          {/* Theme toggle */}
          <button
            onClick={toggleTheme}
            className="w-8 h-8 rounded-full flex items-center justify-center text-fg-muted hover:bg-miku/10 hover:text-miku transition-colors"
            aria-label="切换主题"
          >
            {isDark ? (
              <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <circle cx="12" cy="12" r="5"/>
                <path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42"/>
              </svg>
            ) : (
              <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>
              </svg>
            )}
          </button>
        </div>
      </header>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto px-4 py-6">
        <div className="max-w-3xl mx-auto space-y-5">
          {messages.length === 0 && (
            <div className="flex flex-col items-center justify-center mt-32 max-sm:mt-20 text-fg-muted select-none">
              <div className="w-16 h-16 rounded-full bg-miku/10 flex items-center justify-center mb-4">
                <svg className="w-8 h-8 text-miku" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                  <path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5"/>
                </svg>
              </div>
              <p className="text-lg font-medium text-fg-secondary">问我关于 Galgame 的问题</p>
              <p className="text-sm mt-1.5">比如 &quot;Key社有哪些催泪作品&quot; 或 &quot;空门苍线怎么样&quot;</p>
            </div>
          )}

          {messages.map(message => (
            <div key={message.id} className={`flex items-start gap-2.5 ${message.role === 'user' ? 'flex-row-reverse' : ''}`}>
              {/* Avatar */}
              <div
                className={`flex-shrink-0 w-7 h-7 rounded-full flex items-center justify-center text-[11px] font-bold shadow-sm mt-1 transition-colors ${
                  message.role === 'user'
                    ? 'bg-border text-fg-muted'
                    : 'bg-gradient-to-br from-miku to-miku-dark text-white'
                }`}
              >
                {message.role === 'user' ? 'U' : 'M'}
              </div>

              {/* Bubble */}
              <div className="max-w-[80%] max-sm:max-w-[calc(100%-3rem)] break-words">
                <div
                  className={`transition-colors ${
                    message.role === 'user'
                      ? 'bg-miku text-white rounded-2xl rounded-tr-sm px-4 py-2.5'
                      : 'bg-surface text-fg rounded-2xl rounded-tl-sm px-4 py-2.5 border border-border/70 shadow-sm'
                  }`}
                >
                  {message.parts?.map((part: any, i) => {
                    switch (part.type) {
                      case 'text':
                        if (message.role === 'user') {
                          return <div key={`${message.id}-${i}`} className="whitespace-pre-wrap">{part.text}</div>;
                        }
                        return (
                          <div
                            key={`${message.id}-${i}`}
                            className="prose prose-sm max-w-none prose-p:my-1 prose-headings:my-2 prose-headings:text-fg prose-a:text-miku prose-a:no-underline hover:prose-a:underline prose-code:bg-prose-bg prose-code:px-1 prose-code:rounded prose-code:text-sm prose-pre:bg-prose-bg prose-pre:border prose-pre:border-border prose-pre:rounded-xl prose-li:my-0 prose-strong:text-fg prose-hr:border-border"
                          >
                            <Markdown remarkPlugins={[remarkGfm]}>{part.text}</Markdown>
                          </div>
                        );

                      // Weather tool
                      case 'tool-weather': {
                        const isIntermediate = message.parts.some(
                          (p, index) => index > i && p.type === 'tool-convertFahrenheitToCelsius',
                        );
                        if (part.state === 'output-available') {
                          if (isIntermediate) {
                            return (
                              <div key={`${message.id}-${i}`} className="text-xs text-fg-muted italic mt-2">
                                已获取原始气象数据...
                              </div>
                            );
                          }
                          return (
                            <div
                              key={`${message.id}-${i}`}
                              className="p-2.5 my-2 bg-miku/5 rounded-xl border border-miku/20"
                            >
                              <div className="text-sm text-miku-dark font-medium">📍 {part.output.location}</div>
                              <div className="text-lg font-semibold text-fg">{part.output.temperature}°F</div>
                            </div>
                          );
                        }
                        return (
                          <div key={`${message.id}-${i}`} className="animate-pulse text-xs text-fg-muted mt-2">
                            正在调取气象站...
                          </div>
                        );
                      }

                      // Temperature conversion
                      case 'tool-convertFahrenheitToCelsius': {
                        if (part.state === 'output-available') {
                          return (
                            <div
                              key={`${message.id}-${i}`}
                              className="p-2.5 my-2 bg-gradient-to-r from-miku/10 to-miku-light/20 rounded-xl border border-miku/30"
                            >
                              <div className="text-xs text-fg-muted">温度换算</div>
                              <div className="text-lg font-bold text-miku-dark">{part.output.celsius}°C</div>
                            </div>
                          );
                        }
                        return null;
                      }

                      // Add resource
                      case 'tool-addResource': {
                        if (part.state === 'output-available') {
                          return (
                            <div
                              key={`${message.id}-${i}`}
                              className="p-2 my-1.5 text-xs text-emerald-600 bg-emerald-50 dark:bg-emerald-950/30 dark:text-emerald-400 rounded-lg border border-emerald-200 dark:border-emerald-800"
                            >
                              ✅ 已记住一条新信息
                            </div>
                          );
                        }
                        return (
                          <div key={`${message.id}-${i}`} className="animate-pulse text-xs text-fg-muted mt-1">
                            正在存入知识库...
                          </div>
                        );
                      }

                      // Knowledge base retrieval
                      case 'tool-getInformation': {
                        if (part.state === 'output-available') {
                          // 只渲染第一个有结果的 tool 卡片，其它 tool 的结果合并到它里面
                          const firstWithResults = message.parts.findIndex(
                            (p: any) =>
                              p.type === 'tool-getInformation' &&
                              p.state === 'output-available' &&
                              p.output?.length,
                          );
                          if (i !== firstWithResults) return null;

                          // 合并所有已完成的 tool 结果（包括后续轮次追加的 tool）
                          const allResults = message.parts
                            .filter(
                              (p: any) =>
                                p.type === 'tool-getInformation' && p.state === 'output-available',
                            )
                            .flatMap((p: any) => p.output || [])
                            .filter(Boolean);

                          // 去重
                          const seen = new Set<string>();
                          const unique = allResults.filter((r: any) => {
                            const contentKey =
                              typeof r.content === 'string'
                                ? r.content.slice(0, 100)
                                : String(r.content ?? '');
                            const key = `${r.metadata?.source || ''}|${contentKey}`;
                            if (seen.has(key)) return false;
                            seen.add(key);
                            return true;
                          });

                          if (unique.length === 0) return null;

                          const MAX_DISPLAY = 5;
                          const displayItems = unique.slice(0, MAX_DISPLAY);
                          const hasMore = unique.length > MAX_DISPLAY;

                          const sourceLabel = (meta: any) => {
                            const name = meta?.gameName || meta?.charName || '';
                            switch (meta?.type) {
                              case 'comment': return `${name} 相关评论`;
                              case 'review': return `${name} 相关长评`;
                              case 'char_review': return `${name} 相关评论`;
                              case 'character': return `${name} 角色介绍`;
                              case 'game_intro': return `${name} 作品简介`;
                              default: return name || '';
                            }
                          };

                          return (
                            <div
                              key={`${message.id}-${i}`}
                              className="p-3 my-2 bg-miku/5 rounded-xl border border-miku/25"
                            >
                              <div className="font-semibold mb-2 text-miku-dark text-sm">
                                📖 知识库 ({unique.length} 条)
                              </div>
                              {displayItems.map((r: any, j: number) => (
                                <div
                                  key={j}
                                  className={`${j > 0 ? 'mt-2 pt-2 border-t border-miku/10' : ''}`}
                                >
                                  <div className="text-sm text-fg leading-relaxed break-words">{r.content}</div>
                                  {(r.metadata?.gameName || r.metadata?.charName) && (
                                    <div className="text-xs text-fg-muted mt-1">{sourceLabel(r.metadata)}</div>
                                  )}
                                </div>
                              ))}
                              {hasMore && (
                                <div className="text-xs text-fg-muted mt-2 text-center">
                                  ...还有 {unique.length - MAX_DISPLAY} 条结果
                                </div>
                              )}
                            </div>
                          );
                        }
                        return (
                          <div key={`${message.id}-${i}`} className="animate-pulse text-xs text-fg-muted mt-1">
                            🔍 正在检索知识库...
                          </div>
                        );
                      }

                      default:
                        return null;
                    }
                  })}
                </div>
              </div>
            </div>
          ))}
          <div ref={bottomRef} />
        </div>
      </div>

      {/* Input area */}
      <div className="border-t border-border/70 bg-surface px-4 py-3 transition-colors" style={{ paddingBottom: 'calc(0.75rem + env(safe-area-inset-bottom, 0px))' }}>
        <div className="max-w-3xl mx-auto">
          <div className="flex items-center gap-2 bg-subtle rounded-2xl border border-border/80 focus-within:border-miku focus-within:ring-2 focus-within:ring-miku/15 transition-all px-4">
            <input
              className="flex-1 bg-transparent outline-none text-sm text-fg placeholder-fg-muted py-3"
              value={input}
              placeholder="输入问题..."
              onChange={e => setInput(e.currentTarget.value)}
              onKeyDown={e => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  handleSend();
                }
              }}
            />
            <button
              onClick={isLoading ? stop : handleSend}
              disabled={(!input.trim() && !isLoading)}
              className="flex-shrink-0 w-9 h-9 max-sm:w-11 max-sm:h-11 rounded-full bg-miku hover:bg-miku-dark disabled:bg-fg-muted flex items-center justify-center transition-colors disabled:cursor-not-allowed"
            >
              {isLoading ? (
                <svg className="w-4 h-4 text-white" viewBox="0 0 24 24" fill="currentColor">
                  <rect x="6" y="6" width="5" height="12" rx="1"/>
                  <rect x="13" y="6" width="5" height="12" rx="1"/>
                </svg>
              ) : (
                <svg className="w-4 h-4 text-white" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                  <path d="M5 12h14M12 5l7 7-7 7"/>
                </svg>
              )}
            </button>
          </div>
          <p className="text-[11px] text-fg-muted text-center mt-2">AI 回复仅供参考，请以实际游戏体验为准</p>
        </div>
      </div>
    </div>
  );
}

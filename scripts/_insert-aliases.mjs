/**
 * 将 alias-merge-output.txt 中的新别名插入 name-aliases.ts
 * 插在 GAME_ALIASES 和 CHAR_ALIASES 的最后一个条目后面（闭括号前）
 */
import { readFileSync, writeFileSync } from 'fs';

const src = readFileSync('scripts/lib/name-aliases.ts', 'utf-8');
const newContent = readFileSync('alias-merge-output.txt', 'utf-8');

// 按注释头拆出新内容：游戏别名部分、角色别名部分
const gameSectionMatch = newContent.match(
  /(\/\/ === 补爬新增游戏别名[\s\S]*?)(?=\/\/ === 补爬新增角色别名|$)/
);
const charSectionMatch = newContent.match(
  /(\/\/ === 补爬新增角色别名[\s\S]*?)(?=\s*$)/
);

if (!gameSectionMatch || !charSectionMatch) {
  console.error('无法解析 alias-merge-output.txt');
  process.exit(1);
}

const gameInsert = gameSectionMatch[1].trimEnd();
const charInsert = charSectionMatch[1].trimEnd();

// 在 GAME_ALIASES 最后一个条目后、闭括号前插入
// 找到 "次元凸拉巴" 那一行后面的闭括号
const gameCloseBrace = src.indexOf('\n}', src.indexOf('export const GAME_ALIASES'));
if (gameCloseBrace < 0) { console.error('找不到 GAME_ALIASES 闭括号'); process.exit(1); }
const result1 = src.slice(0, gameCloseBrace) + '\n\n' + gameInsert + '\n' + src.slice(gameCloseBrace);

// 在 CHAR_ALIASES 最后一个条目后、闭括号前插入
const charStart = result1.indexOf('export const CHAR_ALIASES');
const charCloseBrace = result1.indexOf('\n}', charStart);
if (charCloseBrace < 0) { console.error('找不到 CHAR_ALIASES 闭括号'); process.exit(1); }
const result = result1.slice(0, charCloseBrace) + '\n\n' + charInsert + '\n' + result1.slice(charCloseBrace);

writeFileSync('scripts/lib/name-aliases.ts', result, 'utf-8');
console.log('插入完成');
console.log('文件大小:', result.length, 'bytes');

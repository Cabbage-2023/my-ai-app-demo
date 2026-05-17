import { readFileSync, readdirSync, writeFileSync } from 'fs';

// ===== TC→SC 映射（常用字）=====
const tc2sc = {
  '裏':'里','裡':'里','後':'后','雲':'云','體':'体','關':'关',
  '學':'学','會':'会','畫':'画','號':'号','葉':'叶','見':'见',
  '風':'风','鳥':'鸟','魚':'鱼','馬':'马','龍':'龙','萬':'万',
  '與':'与','無':'无','聽':'听','開':'开','門':'门','問':'问',
  '國':'国','時':'时','間':'间','頭':'头','點':'点','個':'个',
  '東':'东','樂':'乐','對':'对','說':'说','書':'书','長':'长',
  '過':'过','處':'处','條':'条','裏':'里','來':'来','爲':'为',
  '於':'于','鬥':'斗','黨':'党','當':'当','發':'发','還':'还',
  '這':'这','隻':'只','幾':'几','盡':'尽','習':'习','係':'系',
  '幹':'干','並':'并','産':'产','眾':'众','創':'创','勝':'胜',
  '勞':'劳','勢':'势','動':'动','務':'务','區':'区','協':'协',
  '參':'参','叢':'丛','嚴':'严','變':'变','將':'将','復':'复',
  '複':'复','夾':'夹','奪':'夺','奮':'奋','婦':'妇','孫':'孙',
  '層':'层','嶽':'岳','巖':'岩','壓':'压','壯':'壮','戀':'恋',
  '戰':'战','戲':'戏','殘':'残','殺':'杀','漢':'汉','満':'满',
  '沢':'泽','潔':'洁','燈':'灯','燒':'烧','獅':'狮','獣':'兽',
  '獸':'兽','獲':'获','環':'环','監':'监','盤':'盘','確':'确',
  '禮':'礼','穀':'谷','穩':'稳','積':'积','窮':'穷','窓':'窗',
  '窓':'窗','絕':'绝','繼':'继','續':'续','線':'线','緣':'缘',
  '編':'编','練':'练','緩':'缓','綠':'绿','網':'网','緊':'紧',
  '總':'总','縮':'缩','織':'织','繪':'绘','繰':'绕','縄':'绳',
  '縣':'县','職':'职','肅':'肃','臉':'脸','臨':'临','艦':'舰',
  '藝':'艺','範':'范','節':'节','簡':'简','粋':'粹','經':'经',
  '絆':'绊','綜':'综','綴':'缀','綺':'绮','綾':'绫','綿':'绵',
  '緋':'绯','緒':'绪','締':'缔','縛':'缚','縱':'纵','縷':'缕',
  '懸':'悬','姫':'姬','桜':'樱','暁':'晓','涙':'泪','焼':'烧',
  '円':'圆','闘':'斗','徳':'德','暦':'历','歩':'步','渉':'涉',
  '満':'满','沢':'泽','潔':'洁','浜':'滨','瀬':'濑','濑':'濑',
  '霊':'灵','響':'响','顕':'显','駆':'驱','鉄':'铁','鉱':'矿',
  '鈴':'铃','鋼':'钢','録':'录','鏡':'镜','鐘':'钟','鉄':'铁',
  '銳':'锐','錆':'锈','錆':'锈','録':'录','鏡':'镜','鐘':'钟',
};

function toSC(s) {
  return [...s].map(c => tc2sc[c] || c).join('');
}

// ===== 解析 review 文件 =====
const content = readFileSync('suggested-aliases-review.txt', 'utf-8');
const lines = content.split('\n');
const parsedDir = 'scripts/data/parsed';

function loadGameNames() {
  const map = {};
  readdirSync(parsedDir + '/games').filter(f => f.endsWith('.json')).forEach(f => {
    const d = JSON.parse(readFileSync(parsedDir + '/games/' + f, 'utf-8'));
    map[d.id] = d.nameCN || d.name;
  });
  return map;
}
function loadCharNames() {
  const map = {};
  readdirSync(parsedDir + '/characters').filter(f => f.endsWith('.json')).forEach(f => {
    JSON.parse(readFileSync(parsedDir + '/characters/' + f, 'utf-8')).forEach(c => {
      map[c.id] = c.nameCN || c.name;
    });
  });
  return map;
}

const gameNames = loadGameNames();
const charNames = loadCharNames();

let section = null;
const gameEntries = {};  // id → alias[]
const charEntries = {};

for (const line of lines) {
  if (line.includes('=== 游戏别名 ===')) { section = 'games'; continue; }
  if (line.includes('=== 角色别名 ===')) { section = 'chars'; continue; }
  if (line.startsWith('//') || !line.trim()) continue;

  if (section === 'games') {
    const m = line.match(/^(\d+)\s*\|\s*(?:.*?\|\s*)?(\[.*\])\s*$/);
    if (m) {
      try {
        const a = JSON.parse(m[2]);
        if (Array.isArray(a) && a.length > 0) gameEntries[m[1]] = a;
      } catch(e) {}
    }
  } else if (section === 'chars') {
    const m = line.match(/^(\d+)\s*\|/);
    if (m) {
      const s = line.indexOf('[');
      const e = line.lastIndexOf(']');
      if (s >= 0 && e > s) {
        try {
          const a = JSON.parse(line.slice(s, e + 1));
          if (Array.isArray(a) && a.length > 0) charEntries[m[1]] = a;
        } catch(e) {}
      }
    }
  }
}

// ===== 按 key 聚合后生成代码（同一别名映射多个实体时合并到同一条）=====

function aggregateByAlias(entries, nameMap) {
  const map = {};  // alias → Set<targetName>
  for (const [id, aliases] of Object.entries(entries)) {
    const target = nameMap[id];
    if (!target) { console.error('SKIP ' + id + ': not found'); continue; }
    for (const a of aliases) {
      const sc = toSC(a);
      if (sc === target) continue;
      if (!map[sc]) map[sc] = new Set();
      map[sc].add(target);
    }
  }
  return map;
}

const aggGames = aggregateByAlias(gameEntries, gameNames);
const aggChars = aggregateByAlias(charEntries, charNames);

let out = '\n  // === 补爬新增游戏别名（2026-05-18）===\n';
for (const [alias, targets] of Object.entries(aggGames)) {
  const vals = [...targets].map(t => `'${t.replace(/'/g, "\\'")}'`).join(', ');
  out += `  '${alias.replace(/'/g, "\\'")}': [${vals}],\n`;
}

out += '\n  // === 补爬新增角色别名（2026-05-18）===\n';
for (const [alias, targets] of Object.entries(aggChars)) {
  const vals = [...targets].map(t => `'${t.replace(/'/g, "\\'")}'`).join(', ');
  out += `  '${alias.replace(/'/g, "\\'")}': [${vals}],\n`;
}

writeFileSync('alias-merge-output.txt', out, 'utf-8');
console.log('=== 统计 ===');
console.log('游戏别名: ' + Object.keys(gameEntries).length + ' 个游戏');
console.log('角色别名: ' + Object.keys(charEntries).length + ' 个角色');
console.log('');
console.log('=== 游戏原名对照（确认用）===');
for (const id of Object.keys(gameEntries).sort((a,b)=>a-b)) {
  console.log('  ' + id + ' → "' + gameNames[id] + '"  aliases=' + JSON.stringify(gameEntries[id]));
}
console.log('');

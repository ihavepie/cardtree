/* 静态审计：**悬停/按下的令牌不许出现在常驻状态里**。
 * 起因（用户报的 bug）：「在侧栏选中文件夹 → 取消选中，主卡片上还留着一块白印子」——
 * `.cascade-card.focused` 用的是 `--hover-bg`（悬停语义），而浅色下 `--hover-bg` 已经是
 * **白色高光**（rgba(255,255,255,.5)），于是这个"常驻标记"就成了一块白斑；再加上
 * `clearSelection()` 没清 `focusId`，它就一直留着。
 * 规则：用了 --hover-bg / --hover-bg-strong / --hover-border / --active-bg* 的规则，
 *       选择器里必须带 :hover / :active（`.dragging` 期间的临时态也允许，但只限 drop 相关）。
 * 用法：node test/css-state-audit.mjs
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const FILE = fileURLToPath(new URL('../src/styles.css', import.meta.url));
const css = readFileSync(FILE, 'utf8');
const TOKENS = /var\(--(hover-bg|hover-bg-strong|hover-border|active-bg|active-bg-solid|row-hover)\)/;
// 这些是"拖拽进行中"的临时反馈，允许借用悬停令牌
const TRANSIENT = /\.dragging|drop-inside|drop-invalid/;

const blocks = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({ sel: m[1].trim().replace(/\s+/g, ' '), body: m[2] }));

const bad = [];
for (const b of blocks) {
  // 只看"真的在用"这个令牌的声明：`--row-hover: var(--hover-bg)` 那种令牌转发不算
  const decls = b.body.split('\n').map((l) => l.trim()).filter((l) => l && TOKENS.test(l) && !l.startsWith('--'));
  if (!decls.length) continue;
  if (/:hover|:active/.test(b.sel)) continue;
  if (TRANSIENT.test(b.sel)) continue;
  bad.push({ sel: b.sel, token: decls[0].match(TOKENS)[0], decl: decls.join(' ') });
}

if (bad.length) {
  console.log('❌ 悬停/按下令牌出现在常驻状态里，共', bad.length, '处：');
  for (const x of bad) console.log(`  ${x.sel}  →  ${x.decl}`);
  process.exitCode = 1;
} else {
  console.log('✅ 悬停/按下令牌只出现在 :hover / :active / 拖拽临时态里');
}

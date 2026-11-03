# 书签板（cardtree）

一个 Chrome / Edge 扩展（Manifest V3）：**把新标签页变成「书签板」书签管理器**。
仿照 [CardTree Bookmarks](https://chromewebstore.google.com/detail/cardtree-bookmarks/ecdimagmnlbhoekbhhkdfhgenhpmbhkf) 的卡片树布局，浅色玻璃拟态视觉，重点打磨**拖拽整理**体验。

技术栈：**Vite + Vue 3**（Composition API），拖拽基于原生 HTML5 Drag & Drop，零额外拖拽库。

## ✨ 功能

**布局与浏览**

- **新标签页即桌面**：`chrome_url_overrides.newtab`，打开新标签页直接进入
- **卡片树级联布局**：以「书签栏」为唯一顶层（其他书签 / 移动设备书签的内容自动平铺进来），子文件夹用「标题 + 树线」扁平嵌套，首次默认折叠、点开才展开
- **文件夹排列可切换**：纵排（一条条往下堆）/ 并排（栏数按窗口宽度自适应）；书签始终横排并排；选择持久化
- **前 N 个 + 展开全部**：每个文件夹的直接书签默认显示前 8 个，其余收成一条「展开全部 N 个」，卡片高度基本恒定；展开状态按文件夹记住
- **一键折叠 / 展开**所有子文件夹
- **自定义背景**：内置渐变壁纸预设 + 本地上传图片 + 一键随机，持久化保存
- **浅色 / 深色主题**：一键切换两套 UI，跟随系统偏好持久化

**侧边栏**

- **文件夹树**：**单击 = 选中 + 定位 + 展开/收缩**（三合一），点箭头单独展开/收缩；右键可收缩展开、新建书签/子文件夹、重命名、移动、删除；支持把主区书签/文件夹**拖入侧边栏文件夹**；顶栏 ☰ 收起
- **两张并列的玻璃卡片**：上「工作区」（我要打开的）、下「文件夹」（我要整理的），各自有独立滚动条
- **三个拖动把手**（都是「鼠标移上去才浮出」）：卡片顶部拖拽条**换位**、中间分隔条**调高度**、右边缘**调宽度**；顺序 / 高度 / 宽度全部持久化
- **拖拽投放反馈**：一开始拖整栏进入投放态（两张卡都亮成投放区 + 顶栏文案变「移入文件夹」）；悬停的文件夹行高亮为落点；拖文件夹到它自己/后代时整行变灰并拒绝落点
- **贴边唤出**：侧栏收起时，拖拽中把鼠标贴到窗口左边缘（≤12px）停 200ms，侧栏临时滑出；真的用它投放了就留着，只是路过则还原你原本的设置
- **hover 快捷动作**：悬停文件夹行时右侧浮出「＋（在此新建书签）」「⋯（重命名/移动/删除）」

**工作区（一键打开一组）**

- **点一行 = 展开**，逐个列出组内每个标签页；**点其中某一个 = 只开这一个**；悬停「✕」从组里移除（不动书签）
- **打开整组**：悬停的第一个按钮「⧉」，或「⋯ → 立即打开全部」——走后台标签并给一条带**撤销**的提示
- **把书签/文件夹直接拖到工作区行上 = 加进这一组**：语义是**登记不是移动**（工作区只是"我要开的这几个站"的清单，书签本体留在原文件夹里）。拖文件夹进来会递归收集里面的书签
- 条目存 `{ id, title, url }`，`title/url` 是**快照兜底**：渲染与打开优先用 `id` 取书签当前值 —— 改名/改网址会跟着变；书签被删则退回快照并标「已删除」徽标，工作区不散架

**看板索引条 / 搜索**

- **吸顶工具栏**：「文件夹」胶囊（含数量）点一下跳转并高亮该分组；「标签」胶囊按标签筛选（空文件夹自动剪掉、命中的文件夹自动展开）；「最近浏览」也在这条同一行
- **全局搜索**：按标题 / 网址 / 标签 / 描述过滤，点击结果中的文件夹可定位展开（搜索时索引条让位）

**整理操作**

- **完整拖拽**：网格内拖拽排序（左半前插 / 右半后插）、拖入文件夹、文件夹互相嵌套、拖回书签栏根卡片；拖拽幽灵 + 数量角标 + 插入指示线；悬停折叠文件夹 **600ms 自动展开**；拖入自身/后代自动阻止
- **选中 / 打开**：单击选中、双击打开；Ctrl/⌘ 多选、Shift 范围选择
- **新建 / 重命名 / 移动 / 删除**：顶栏「新建书签 / 新建文件夹」、右键菜单、支持多选批量移动
- **回收站**：删除进回收站（软删除），可恢复（原文件夹不在则回到书签栏）或彻底删除 / 清空
- **最近浏览 / 常用**：书签栏卡片内最上方两个分组；「常用」按打开次数只保留最常访问的 10 个

**其他**

- **图标自适应**：优先 `_favicon` 服务，失败回退彩色首字母圆角块
- **实时同步**：监听 `onCreated/onRemoved/onChanged/onMoved/onChildrenReordered/onImportEnded` 自动刷新

## 🔎 改了代码但界面没变？

顶栏的版本号是从 `chrome.runtime.getManifest()` **实时读的**（`TopBar.vue`）：

- 顶栏显示 `v5.1` = 新构建已生效
- 还显示旧版本号 = 扩展没重载 → 去 `chrome://extensions` 点这个扩展的**刷新**按钮

扩展加载的是 `dist/`，浏览器**不会**自动重载已加载扩展的代码，每次 `npm run build` 后都要点一次刷新。

## 🚀 安装（加载扩展）

1. 构建产物
   ```bash
   cd cardtree
   npm install
   npm run build      # 产出 dist/
   ```
2. 打开 `chrome://extensions`（Edge 为 `edge://extensions`）
3. 开启「开发者模式」→「加载已解压的扩展程序」
4. 选择 `cardtree/dist` 文件夹，新建标签页即可使用

> 若只想本地跑界面：`npm run dev` 后访问 `http://localhost:5173/`（非扩展环境自动注入示例数据）。

## 🧪 测试

```bash
python3 -m http.server 5199 --directory dist &   # 各脚本都从 5199 取页面

node test/cdp-driver.mjs                # 交互回归：渲染/折叠/拖拽排序/拖入文件夹/嵌套/右键/搜索/新建/回收站
node test/layout-modes-check.mjs        # 文件夹排列：纵排 / 并排的栏数与列轨道、按钮切换、持久化
node test/grid-preview-check.mjs        # 前 N 个 + 展开全部：8→16→8、按钮文案、持久化、拖拽落点
node test/board-index-check.mjs         # 索引条：文件夹跳转、标签聚合/筛选/再点取消/空态、搜索时让位
node test/sidebar-drop-check.mjs        # 侧栏投放反馈：拖拽态/落点高亮/非法目标/松手真的移动/贴边唤出
node test/panel-native-drag-check.mjs   # mock 页面下用真实鼠标事件验证换位 + 三个把手是否"悬停才浮出"
node test/panel-drag-extension-check.mjs # 在真正的扩展环境里验（--load-extension + edge://newtab）
node test/workspace-logic-check.mjs     # 工作区逻辑：活引用跟随改名 / 删除后兜底 / 选文件夹递归收集
node test/workspace-check.mjs           # 工作区 + 侧栏卡片布局：空态/建组/展开/整组打开+撤销/拖拽把手
node test/main-sections-check.mjs       # 主区三个标题的文案与顺序、「常用」= 10 条
node test/card-surface-check.mjs        # 所有"卡片面"必须带玻璃边，四张卡都在场
node test/no-purple-check.mjs           # 扫色相 230°–305°、饱和度 >15% 的元素，深浅两套都要求 0 处
node test/sidebar-diag.mjs 2200 1200    # 侧边栏几何：不同窗口/侧栏宽度下"侧栏↔卡片"间距
node test/shot-home.mjs 前缀 1440 940   # 视觉截图（浅色/展开/深色/悬停/拖拽指示线）
```

脚本自启动无头 Edge（路径按 `/Applications` 与外置卷自动探测，可用 `EDGE_BIN=...` 覆盖），截图存于 `test/screens/`。

`cdp-driver` 的 `T6` 带一条断言：**拖拽/排序后若「其他书签 / 移动设备书签」的条目出现在书签栏，即判定失败**（历史上曾因平铺数据被回写而导致真实书签被搬走）。

## 📁 文件结构

```
cardtree/
├── index.html                 # Vite 入口（构建为 dist/index.html）
├── vite.config.js             # base: './'，产物可直接解压加载
├── package.json
├── public/
│   ├── manifest.json          # MV3 清单（bookmarks + storage + favicon）
│   └── icons/                 # 插件图标 16/48/128
├── src/
│   ├── main.js                # 入口：挂载 App + 初始化 store + 拖拽全局监听
│   ├── App.vue                # 顶层布局（顶栏/分区/搜索/全局指示线/弹层）+ 布局模式类
│   ├── styles.css             # 浅色玻璃拟态主题 + 全部组件样式 + 文件夹排列模式
│   ├── bookmarks.js           # chrome.bookmarks 封装 + mock 实现（?mock 自动切换）
│   ├── store.js               # 响应式 store：树/折叠/选中/回收站/最近/工作区/移动/搜索/持久化
│   ├── drag.js                # 书签拖拽控制器：inside/before/after 解析、幽灵、指示线、自动展开
│   ├── ui.js                  # 打开书签、右键菜单、弹窗构建
│   ├── utils.js               # favicon、颜色、防抖等工具
│   └── components/
│       ├── TopBar.vue         # logo + 搜索 + 侧边栏开关 + 新建/回收站按钮
│       ├── Sidebar.vue        # 侧栏列容器：上下两张卡片（工作区 + 文件夹）
│       ├── SidePanel.vue      # 侧栏的一张玻璃卡片：拖拽条 + 标题栏 + 滚动内容区
│       ├── SidebarFolder.vue  # 侧边栏递归文件夹项
│       ├── WorkspaceList.vue  # 工作区：一键开一组 / 展开看每个标签页
│       ├── SearchResults.vue
│       ├── RecentSection.vue
│       ├── BookmarkGrid.vue   # 书签网格（横排并排 + 前 N 个/展开全部）
│       ├── BookmarkItem.vue   # 单个书签卡片（选中/拖拽/右键）
│       ├── CascadeNode.vue    # 文件夹卡片节点（递归，折叠动画）
│       ├── ContextMenu.vue    # 右键菜单（布局选项面板也复用它）
│       ├── AppDialog.vue      # 新建/重命名/移动弹窗
│       └── TrashPanel.vue     # 回收站侧栏
├── tools/gen_icons.py         # 图标生成脚本
└── test/                      # 回归脚本（见上节）+ screens/ 截图
```

## ⚙️ 权限说明

- `bookmarks`：读取与增删改收藏夹（必须）
- `storage`：记住折叠状态、最近打开、回收站
- `favicon`：通过 `_favicon` 服务读取站点真实图标

## ⌨️ 快捷键

| 按键 | 动作 |
| --- | --- |
| 单击书签 | 选中（Ctrl/⌘ 多选，Shift 范围） |
| 双击书签 | 新标签页打开 |
| Enter | 打开选中项 |
| F2 | 重命名选中项 |
| Delete | 删除选中项（进回收站） |
| Esc | 关闭菜单 / 取消选中 |

## 📚 开发笔记

视觉系统的配方与取值、各处踩过的坑（以及为什么回退）、回归脚本对应的断言细节，见 [`docs/NOTES.md`](docs/NOTES.md)。

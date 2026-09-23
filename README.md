# 书签板（cardtree）

一个 Chrome / Edge 浏览器扩展（Manifest V3）：**把新标签页变成「书签板」书签管理器**。
仿照 [CardTree Bookmarks](https://chromewebstore.google.com/detail/cardtree-bookmarks/ecdimagmnlbhoekbhhkdfhgenhpmbhkf) 的卡片树布局，浅色玻璃拟态视觉，重点打磨了**拖拽整理**体验。

技术栈：**Vite + Vue 3**（Composition API），拖拽基于原生 HTML5 Drag & Drop，零额外拖拽库。

## ✨ 功能

- 🏠 **新标签页即桌面**：`chrome_url_overrides.newtab`，打开新标签页直接进入
- 🗂️ **卡片树级联布局**：以「书签栏」为唯一顶层（其他书签/移动设备书签的内容自动平铺进书签栏），子文件夹以「标题 + 树线」扁平嵌套（**首次默认折叠**、点开才展开），仅最外层为毛玻璃面板、内层不叠卡片，亚克力通透
- 🧱 **文件夹排列可切换**：顶栏布局按钮单击即可在「文件夹纵排（一条条往下堆）」与「文件夹并排（栏数按窗口宽度自动）」之间切换；网址（书签）始终保持横排并排，选择持久化
- 📐 **前 N 个 + 展开全部**：每个文件夹的直接书签默认只显示前 8 个，其余收成一条「展开全部 N 个」，卡片高度基本恒定；展开状态按文件夹记住
- 🔽 **一键折叠/展开**：顶栏按钮一键折叠或展开所有子文件夹
- 🧭 **侧边栏文件夹树**：左侧可折叠的文件夹导航，**单击 = 选中 + 定位 + 展开/收缩**（三合一）、**点箭头单独展开/收缩**（与主区卡片双向同步）；右键文件夹可收缩/展开、新建书签/子文件夹、重命名、移动、删除整个文件夹；支持把主区书签/文件夹**拖入侧边栏文件夹**完成移动（顶栏 ☰ 可收起侧边栏）
- 🎨 **自定义背景**：内置多套渐变/壁纸预设 + 本地上传图片 + 一键随机切换，持久化保存
- 🖱️ **完整拖拽**：
  - 网格内拖拽排序（左半前插 / 右半后插）
  - 拖入文件夹（悬停文件夹卡片中间区）
  - 文件夹互相嵌套（拖文件夹标题到另一文件夹）
  - 拖回书签栏根卡片
  - 拖拽幽灵 + 数量角标 + 插入指示线
  - 悬停折叠文件夹 **600ms 自动展开**，方便拖进去
  - 拖入自身/后代自动阻止（防循环嵌套）
- 🔍 **全局搜索**：按标题/网址过滤，点击结果中的文件夹可定位展开到主页
- 🖱️ **单击选中 / 双击打开**：Ctrl/⌘ 多选、Shift 范围选择；Enter 打开、F2 重命名、Delete 删除、Esc 取消
- ➕ **新建 / 重命名 / 移动 / 删除**：顶栏「新建书签 / 新建文件夹」，右键菜单，支持多选批量移动
- 🗑️ **回收站**：删除进回收站（软删除），可恢复（原文件夹不在则回到书签栏）或彻底删除 / 清空
- 🕘 **最近浏览**：书签栏卡片顶部自动展示最近打开的书签分组，一键清除
- 🖼️ **图标自适应**：优先 `_favicon` 服务，失败回退彩色首字母圆角块
- 🌗 **浅色/深色主题**：顶栏按钮一键切换深浅两套 UI，跟随系统偏好持久化
- 🔄 **实时同步**：监听 `onCreated/onRemoved/onChanged/onMoved/onChildrenReordered/onImportEnded` 自动刷新

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
python3 -m http.server 5199 --directory dist &   # 三个脚本都从 5199 取页面

node test/cdp-driver.mjs           # 交互回归：渲染/折叠/拖拽排序/拖入文件夹/嵌套/拖回书签栏/右键/搜索/新建/回收站
node test/layout-modes-check.mjs   # 文件夹排列：纵排 / 并排的栏数与列轨道、按钮切换、拖拽指示线、持久化
node test/grid-preview-check.mjs   # 前 N 个 + 展开全部：8→16→8、按钮文案、持久化、拖拽落点
node test/shot-home.mjs 前缀 1440 940  # 视觉截图（浅色/展开/深色/悬停/拖拽指示线）
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
│   ├── App.vue                # 顶层布局（顶栏/分区/搜索/全局指示线/弹层）+ 布局模式类与 CSS 变量
│   ├── styles.css             # 浅色玻璃拟态主题 + 全部组件样式 + 文件夹排列模式
│   ├── bookmarks.js           # chrome.bookmarks 封装 + mock 实现（?mock 自动切换）
│   ├── store.js               # 响应式 store：树/折叠/选中/回收站/最近/移动/搜索/持久化
│   ├── drag.js                # 拖拽控制器：inside/before/after 解析、幽灵、指示线、自动展开
│   ├── ui.js                  # 打开书签、右键菜单、弹窗构建
│   ├── utils.js               # favicon、颜色、防抖等工具
│   └── components/
│       ├── TopBar.vue         # logo + 搜索 + 侧边栏开关 + 新建/回收站按钮
│       ├── Sidebar.vue        # 侧边栏容器（文件夹树导航）
│       ├── SidebarFolder.vue  # 侧边栏递归文件夹项
│       ├── SearchResults.vue
│       ├── RecentSection.vue
│       ├── BookmarkGrid.vue   # 书签网格（横排并排 + 前 N 个/展开全部）
│       ├── BookmarkItem.vue   # 单个书签卡片（选中/拖拽/右键）
│       ├── CascadeNode.vue    # 文件夹卡片节点（递归，折叠动画）
│       ├── ContextMenu.vue
│       ├── AppDialog.vue      # 新建/重命名/移动弹窗
│       └── TrashPanel.vue     # 回收站侧栏
├── tools/gen_icons.py         # 图标生成脚本
└── test/
    ├── cdp-driver.mjs         # CDP 交互回归（含数据完整性断言）
    ├── layout-modes-check.mjs # 文件夹排列模式校验
    ├── grid-preview-check.mjs # 前 N 个 + 展开全部校验
    ├── shot-home.mjs          # 视觉截图
    └── screens/               # 测试截图
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

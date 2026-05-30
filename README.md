# BilibiliOpus2Markdown

一个油猴（Tampermonkey）用户脚本，把 **B 站专栏 / 图文动态（opus）** 页面一键导出为 Markdown。无法干净映射到 Markdown 的特殊块（视频卡、链接卡、未知组件）会被压缩成紧凑的 **XML 标签**，做到信息不丢、体积可控。

## 基本信息

| 项 | 值 |
|---|---|
| 类型 | Tampermonkey 用户脚本（UserScript） |
| 入口文件 | [`tampermonkey.js`](./tampermonkey.js) |
| 匹配域名 | `*://www.bilibili.com/opus/*` |
| 示例页面 | `https://www.bilibili.com/opus/643177966891696136` |
| 依赖 | [Turndown 7.1.1](https://github.com/mixmark-io/turndown)（通过 `@require` 加载，失败时降级到内置简易转换器） |

## 安装与使用

1. 浏览器安装 [Tampermonkey](https://www.tampermonkey.net/) 扩展。
2. 新建脚本，把 [`tampermonkey.js`](./tampermonkey.js) 全部内容粘贴进去并保存。
3. 打开任意 B 站专栏页面（`bilibili.com/opus/...`）。
4. 点击右下角 **「下载为 Markdown」** 按钮，即可下载 `(日期)标题_作者.md`。

## 转换规则

- **正文**：标题、段落、加粗、列表、图片 → 标准 Markdown。
- **图片**：统一补全为 `https://` 绝对地址。
- **装饰分割线**（cut-off 小图）→ `---`。
- **特殊块 → XML 标签压缩总结**：
  - 视频 / UGC 卡 → `<video-card title="…" duration="02:23" stat="…" cover="https://…" url="…"/>`
  - 普通链接卡 → `<link-card title="…" url="…"/>`
  - 未识别的 `opus-*` 块 → `<unknown-block kind="…">纯文本摘要</unknown-block>`（兜底）
- 顶部 TOC、底部分享 / 版权 / 作者操作等非正文内容会被忽略。

## 参考对象

本项目参考 **[zhihu-download](https://github.com/GlActions/zhihu-download)** 的油猴脚本实现（仓库内 [`zhihu-download/tampermonkey.js`](./zhihu-download/tampermonkey.js)），沿用其整体结构：

- 注入式下载按钮 + 进度提示 UI
- 基于 Turndown 的 HTML→Markdown 转换，并提供降级方案
- `cloneNode` 处理正文、不改动页面；MutationObserver 应对 SPA 路由切换

在此基础上针对 B 站 opus 的 DOM 结构重写了选择器与转换规则，并新增「特殊块用 XML 标签压缩」的能力。

## 仓库结构

```
.
├── tampermonkey.js          # 主脚本
├── bilibili-opus.html       # 真实页面样本（用于验证选择器 / 结构）
├── docs/superpowers/specs/  # 设计文档
├── zhihu-download/          # 参考实现（被 .gitignore 忽略）
└── README.md
```

// ==UserScript==
// @name         BilibiliOpus2Markdown
// @namespace    http://tampermonkey.net/
// @version      1.0
// @description  Download Bilibili opus (专栏/图文动态) as Markdown, compressing special blocks into XML tags
// @author       ChocoLZS
// @match        *://www.bilibili.com/opus/*
// @icon         https://www.bilibili.com/favicon.ico
// @grant        GM_addStyle
// @require      https://cdn.jsdelivr.net/npm/turndown@7.1.1/dist/turndown.js
// @run-at       document-end
// ==/UserScript==

(function () {
    'use strict';

    // ---- UI styles (reused from the zhihu script) ----
    GM_addStyle(`
        .bili-dl-button {
            position: fixed;
            bottom: 30px;
            right: 30px;
            z-index: 10000;
            padding: 12px 16px;
            background: #fb7299;
            color: white;
            border: none;
            border-radius: 8px;
            cursor: pointer;
            font-size: 15px;
            font-weight: 500;
            box-shadow: 0 4px 12px rgba(0, 0, 0, 0.2);
            transition: all 0.2s ease;
            display: flex;
            align-items: center;
            justify-content: center;
        }
        .bili-dl-button:hover {
            background: #f25d8e;
            transform: translateY(-2px);
            box-shadow: 0 6px 16px rgba(0, 0, 0, 0.25);
        }
        .bili-dl-button:before {
            content: "⬇️";
            margin-right: 6px;
            font-size: 16px;
        }
        .bili-dl-progress {
            position: fixed;
            bottom: 90px;
            right: 30px;
            z-index: 10000;
            padding: 10px 16px;
            background: white;
            border: 1px solid #eee;
            border-radius: 8px;
            font-size: 14px;
            color: #18191c;
            box-shadow: 0 4px 12px rgba(0, 0, 0, 0.1);
            display: none;
        }
    `);

    // ---- Small helpers ----

    // Replace characters that are invalid in filenames.
    const getValidFilename = (str) => str.replace(/[\\/:*?"<>|]/g, '_').trim();

    // Normalize a Bilibili URL to always start with https://.
    // Handles protocol-relative ("//i0.hdslb.com/..."), http://, and bare hosts.
    const absolutize = (url) => {
        if (!url) return '';
        url = url.trim();
        if (url.startsWith('//')) return 'https:' + url;
        if (url.startsWith('http://')) return 'https://' + url.slice(7);
        if (url.startsWith('https://')) return url;
        // Bare host or path-relative -> assume https://
        return 'https://' + url.replace(/^\/+/, '');
    };

    // Escape a string so it is safe inside an XML attribute value.
    const escapeAttr = (str) =>
        String(str || '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/\s+/g, ' ')
            .trim();

    // Escape text used inside an XML element body.
    const escapeText = (str) =>
        String(str || '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/\s+/g, ' ')
            .trim();

    // Build an XML tag string from a tag name + attribute object, omitting
    // empty attributes. If `body` is null -> self-closing tag.
    const buildXmlTag = (tag, attrs, body) => {
        const attrStr = Object.entries(attrs)
            .filter(([, v]) => v !== undefined && v !== null && String(v).trim() !== '')
            .map(([k, v]) => `${k}="${escapeAttr(v)}"`)
            .join(' ');
        const open = attrStr ? `${tag} ${attrStr}` : tag;
        if (body === null || body === undefined) {
            return `\n\n<${open}/>\n\n`;
        }
        return `\n\n<${open}>${escapeText(body)}</${tag}>\n\n`;
    };

    const text = (node, selector) => {
        const el = selector ? node.querySelector(selector) : node;
        return el ? el.textContent.trim().replace(/\s+/g, ' ') : '';
    };

    // ---- Turndown configuration ----
    const createTurndownService = () => {
        const service = new TurndownService({
            headingStyle: 'atx',
            codeBlockStyle: 'fenced',
            bulletListMarker: '-'
        });

        // Headings (B站 opus 用 <h1><strong>…</strong></h1> 表示小节标题)
        service.addRule('opusHeadings', {
            filter: ['h1', 'h2', 'h3', 'h4', 'h5', 'h6'],
            replacement: (content, node) => {
                const level = Number(node.nodeName.charAt(1));
                const title = node.textContent.trim().replace(/\s+/g, ' ');
                return `\n\n${'#'.repeat(level)} ${title}\n\n`;
            }
        });

        // Decorative cut-off divider lines -> ---
        service.addRule('opusDivider', {
            filter: (node) =>
                node.nodeName === 'FIGURE' && node.classList.contains('opus-para-line'),
            replacement: () => '\n\n---\n\n'
        });

        // Images: always emit an https:// src. Covers every <img> reachable in
        // the content so none falls through to Turndown's default //-relative rule.
        service.addRule('opusImage', {
            filter: 'img',
            replacement: (content, node) => {
                const src = absolutize(
                    node.getAttribute('src') || node.getAttribute('data-src')
                );
                if (!src) return '';
                const alt = node.getAttribute('alt') || '';
                return `\n\n![${alt}](${src})\n\n`;
            }
        });

        // Special blocks -> compact XML summary tags.
        service.addRule('opusLinkCard', {
            filter: (node) =>
                node.nodeName === 'DIV' && node.classList.contains('opus-para-link-card'),
            replacement: (content, node) => convertCard(node)
        });

        // Fallback: any still-unrecognized opus-* block becomes <unknown-block>.
        service.addRule('opusUnknownBlock', {
            filter: (node) => {
                if (node.nodeName !== 'DIV') return false;
                const cls = node.className || '';
                if (typeof cls !== 'string') return false;
                // Only top-ish opus blocks we have not handled above.
                return /\bopus-para-(?!pic|line|link-card)[\w-]+/.test(cls);
            },
            replacement: (content, node) => {
                const kind = (node.className.match(/opus-para-[\w-]+/) || ['opus-block'])[0];
                return buildXmlTag('unknown-block', { kind }, node.textContent);
            }
        });

        // Drop purely decorative nodes.
        service.addRule('opusDecorative', {
            filter: (node) => {
                if (node.nodeName === 'SVG') return true;
                const cls = typeof node.className === 'string' ? node.className : '';
                return /bili-dyn-pic__mask|bili-dyn-pic__loading/.test(cls);
            },
            replacement: () => ''
        });

        return service;
    };

    // Convert a `.opus-para-link-card` into a <video-card> or <link-card> tag.
    const convertCard = (node) => {
        const ugc = node.querySelector('.bili-dyn-card-ugc');
        if (ugc) {
            const title = text(ugc, '.bili-dyn-card-ugc__detail__title');
            const duration = text(ugc, '.bili-dyn-card-ugc__duration');
            const stat = text(ugc, '.bili-dyn-card-ugc__detail__stat');
            const coverImg = ugc.querySelector('.bili-dyn-card-ugc__cover img');
            const cover = coverImg ? absolutize(coverImg.getAttribute('src')) : '';
            const link = node.querySelector('a[href]') || node.closest('a[href]');
            const url = link ? absolutize(link.getAttribute('href')) : '';
            // A card with no resolvable title/url is likely an abnormal/removed video.
            const tip = text(node, '.bili-dyn-tip');
            return buildXmlTag('video-card', {
                title: title || tip,
                duration,
                stat,
                cover,
                url
            }, null);
        }

        // Non-UGC link card (article/live/tip/etc.)
        const tip = text(node, '.bili-dyn-tip');
        const link = node.querySelector('a[href]') || node.closest('a[href]');
        const url = link ? absolutize(link.getAttribute('href')) : '';
        return buildXmlTag('link-card', {
            title: tip || node.textContent,
            url
        }, null);
    };

    // ---- Fallback converter (used only if Turndown fails to load) ----
    const simpleHtmlToMarkdown = (root) => {
        const div = root.cloneNode(true);

        div.querySelectorAll('svg, .bili-dyn-pic__mask, .bili-dyn-pic__loading').forEach((n) => n.remove());

        div.querySelectorAll('figure.opus-para-line').forEach((n) => {
            n.replaceWith(document.createTextNode('\n\n---\n\n'));
        });

        div.querySelectorAll('.opus-para-link-card').forEach((n) => {
            n.replaceWith(document.createTextNode(convertCard(n)));
        });

        div.querySelectorAll('img.b-img__inner').forEach((img) => {
            const src = absolutize(img.getAttribute('src'));
            img.replaceWith(document.createTextNode(src ? `\n\n![](${src})\n\n` : ''));
        });

        ['h1', 'h2', 'h3', 'h4', 'h5', 'h6'].forEach((tag) => {
            div.querySelectorAll(tag).forEach((h) => {
                const level = Number(tag.charAt(1));
                h.replaceWith(document.createTextNode(`\n\n${'#'.repeat(level)} ${h.textContent.trim()}\n\n`));
            });
        });

        div.querySelectorAll('strong, b').forEach((b) => {
            b.replaceWith(document.createTextNode(`**${b.textContent}**`));
        });

        div.querySelectorAll('p').forEach((p) => {
            p.appendChild(document.createTextNode('\n\n'));
        });

        return div.textContent.replace(/\n{3,}/g, '\n\n').trim();
    };

    const isTurndownAvailable = () => {
        try {
            if (typeof TurndownService === 'undefined') return false;
            new TurndownService().turndown('<p>test</p>');
            return true;
        } catch (e) {
            console.error('TurndownService check failed:', e);
            return false;
        }
    };

    // ---- Metadata extraction ----
    const getTitle = () =>
        text(document, '.opus-module-title__text') ||
        (document.title || 'Untitled').replace(/\s*-\s*哔哩哔哩.*$/, '').trim() ||
        'Untitled';

    const getAuthor = () => text(document, '.opus-module-author__name') || 'Unknown';

    const getDate = () => {
        const raw = text(document, '.opus-module-author__pub__text');
        const m = raw.match(/(\d{4})年(\d{2})月(\d{2})日/) || raw.match(/(\d{4})-(\d{2})-(\d{2})/);
        return m ? `${m[1]}-${m[2]}-${m[3]}` : '';
    };

    // ---- Build & download ----
    const buildMarkdown = () => {
        const contentEl = document.querySelector('.opus-module-content');
        if (!contentEl) {
            throw new Error('未找到正文（.opus-module-content），请确认是 opus 专栏页面并已加载完成');
        }

        const title = getTitle();
        const author = getAuthor();
        const date = getDate();
        const url = window.location.href;

        // Clone so we never mutate the live page.
        const content = contentEl.cloneNode(true);

        let body;
        if (isTurndownAvailable()) {
            showProgress('使用 Turndown 转换…');
            body = createTurndownService().turndown(content.innerHTML);
        } else {
            showProgress('Turndown 不可用，使用降级转换…');
            body = simpleHtmlToMarkdown(content);
        }

        // Collapse excess blank lines produced by block rules.
        body = body.replace(/\n{3,}/g, '\n\n').trim();

        let md = `# ${title}\n\n`;
        md += `**作者:** ${author}\n\n`;
        if (date) md += `**日期:** ${date}\n\n`;
        md += `**链接:** ${url}\n\n`;
        md += '---\n\n';
        md += body + '\n';

        return { md, title, author, date };
    };

    const downloadFile = (title, author, date, md) => {
        const filename = getValidFilename(date ? `(${date})${title}_${author}.md` : `${title}_${author}.md`);
        const blob = new Blob([md], { type: 'text/markdown;charset=utf-8' });
        const objUrl = URL.createObjectURL(blob);

        const a = document.createElement('a');
        a.href = objUrl;
        a.download = filename;
        a.style.display = 'none';
        document.body.appendChild(a);
        a.click();

        setTimeout(() => {
            document.body.removeChild(a);
            URL.revokeObjectURL(objUrl);
        }, 100);

        return filename;
    };

    const handleDownload = () => {
        try {
            showProgress('处理专栏内容…');
            const { md, title, author, date } = buildMarkdown();
            const filename = downloadFile(title, author, date, md);
            showProgress(`已下载: ${filename}`, 3000);
        } catch (e) {
            console.error('Bilibili opus download error:', e);
            showProgress(`错误: ${e.message}`, 4000);
        }
    };

    // ---- Progress toast ----
    const showProgress = (message, timeout = 0) => {
        let progress = document.querySelector('.bili-dl-progress');
        if (!progress) {
            progress = document.createElement('div');
            progress.className = 'bili-dl-progress';
            document.body.appendChild(progress);
        }
        progress.textContent = message;
        progress.style.display = 'block';
        if (timeout > 0) {
            setTimeout(() => {
                progress.style.display = 'none';
            }, timeout);
        }
    };

    // ---- Button injection ----
    const addDownloadButton = () => {
        const existing = document.querySelector('.bili-dl-button');
        if (existing) existing.remove();

        const button = document.createElement('button');
        button.textContent = '下载为 Markdown';
        button.className = 'bili-dl-button';
        button.addEventListener('click', handleDownload);
        document.body.appendChild(button);
    };

    const init = () => {
        setTimeout(addDownloadButton, 1500);

        // Re-add button on SPA navigation between opus pages.
        let lastUrl = location.href;
        new MutationObserver(() => {
            if (location.href !== lastUrl) {
                lastUrl = location.href;
                setTimeout(addDownloadButton, 1500);
            }
        }).observe(document, { subtree: true, childList: true });
    };

    init();
})();

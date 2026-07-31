---
name: competitor-platform-router
description: "识别竞品链接所属平台，并自动调用对应抓取 Skill。用户提交抖音、小红书等竞品主页或作品链接，或要求抓取竞品账号时调用。"
---

# 竞品平台路由

用于竞品洞察 Agent 的第一道入口。必须先识别平台，再调用该平台专用抓取 Skill，禁止把一个平台的 Cookie、接口或抓取脚本用于另一个平台。

## 路由规则

1. 从用户输入或分享文字中提取第一个完整 HTTP/HTTPS 链接。
2. 抖音域名包括 `douyin.com`、`v.douyin.com`、`iesdouyin.com`：
   - 自动调用已安装的 `douyin-scraper`。
   - 基础命令：

```bash
~/.codex/skills/douyin-scraper/.venv/bin/python \
  ~/.codex/skills/douyin-scraper/main.py "<抖音链接>" \
  --excel "<当前项目输出目录>"
```

3. 小红书域名包括 `xiaohongshu.com`、`xhslink.com`：
   - 自动调用已安装的 `xiaohongshu-scraper`。
   - 基础命令：

```bash
~/.codex/skills/xiaohongshu-scraper/.venv/bin/python \
  ~/.codex/skills/xiaohongshu-scraper/scripts/fetch_xhs_note.py \
  --url "<小红书链接>" \
  --out-dir "<当前项目输出目录>"
```

   - 不得退回抖音抓取器，也不得自动读取、展示或导出浏览器 Cookie。
4. 其他平台：说明暂未接入，并保留原链接等待新增 Skill。

## 安全边界

- 用户提交链接即授权分析该公开目标，但不等于授权读取、导出或展示浏览器 Cookie。
- 首次平台抓取需要登录时，只允许用户在本机弹出的浏览器中扫码或完成验证。
- 抖音登录态只保存在 `~/.codex/skills/douyin-scraper/`；小红书登录态只保存在 `~/.xhs/chrome-profile/`。均不得写入项目仓库、成果文件或日志。
- 控制抓取频率；遇到平台验证或风控立即停止自动重试，等待用户处理。
- 输出数据用于经营分析时，标注抓取时间和数据口径，不把平台公开互动数解释为成交或真实销售。

## 输出顺序

1. 平台识别结果
2. 调用的 Skill
3. 抓取状态与输出文件
4. 数据完整性说明
5. 竞品内容结构与机会判断

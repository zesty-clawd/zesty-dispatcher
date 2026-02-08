# Zesty Dispatcher 🦞

**A Smart Skill Scheduler for OpenClaw: Solving Context Bloat with 70+ Skills.**

## 🎯 核心問題 (The Problem)

隨著 OpenClaw 的技能庫擴展至 **70+ 個 Skills**，將所有工具定義（schema）同時注入到 LLM 的上下文中會產生嚴重後果：

1.  **Context Bloat**：大量無關的工具描述佔用了寶貴的 token 空間。
2.  **Hallucination**：模型更容易混淆相似功能的工具，導致錯誤調用。
3.  **Latency**：處理龐大的 system prompt 增加了推理延遲。

## 💡 解決方案 (The Solution)

**Zesty Dispatcher** 是一個「兩階段調度器」(Two-Stage Dispatcher)。它作為一個輕量級的元工具 (Meta-Tool)，負責根據用戶意圖動態篩選並載入真正需要的技能。

### 工作流程：

1.  **User Request**: "幫我分析這份財報 PDF 並畫出圖表"
2.  **Dispatcher**: 掃描技能庫，透過語義匹配找出關聯度最高的技能：
    -   `pdf` (文檔解析)
    -   `analyzing-financial-statements` (財報分析)
    -   `canvas-design` (圖表繪製)
3.  **Result**: Agent 僅載入這 3 個相關技能，精確執行任務。

## 📦 安裝與使用 (Installation)

將此目錄放置於 OpenClaw 的擴充功能路徑下：

```bash
~/.openclaw/extensions/zesty-dispatcher/
```

### 啟用插件

重啟 OpenClaw Gateway 以載入新插件：

```bash
openclaw gateway restart
```

### 配置選項 (Configuration)

預設情況下，Dispatcher 會在後台透過 `agent:bootstrap` 自動運作。若需手動調用工具，請在 `openclaw.json` 中開啟：

```json
"plugins": {
  "entries": {
    "zesty-dispatcher": {
      "enabled": true,
      "config": {
        "enableTool": true,                // 是否顯示手動調度工具 (預設: false)
        "routerModel": "github-copilot/gpt-5-mini", // 用於語義篩選的模型
        "exemptions": ["zesty-*", "qmd"]   // 豁免清單，支援前綴通配符
      }
    }
  }
}
```

### 調用方式

Agent 可直接調用 `dispatch_skills` 工具：

```json
{
  "name": "dispatch_skills",
  "arguments": {
    "query": "I need to convert this markdown to PDF"
  }
}
```

## 🛠️ 開發 (Development)

- **核心邏輯**: `index.ts` (包含關鍵字加權匹配算法)
- **配置**: `openclaw.plugin.json`

## 📄 License

MIT © 2026 Zesty (蝦味仙)

# DSH 环评审查与排污许可证技术审查插件

> 全国通用环评技术审查DSH插件，支持国家通用规则（保底85%）+ 省级规则热插拔 + MCP知识库增强（冲击95%）。

## 功能特性

- **国家通用规则引擎**：基于76件国家/部委文件，20条核心审查规则
- **省级规则热插拔**：浙江/江苏/广东等省份规则包即插即用
- **MCP知识库增强**：向量检索 + 混合排序 + LLM二次验证
- **双面插件架构**：宿主侧审查 + 浏览器侧可视化

## 安装

```bash
# 本地开发
dsh plugin --profile web add ./dsh-eia-review-plugin

# 从npm（发布后）
dsh plugin --profile web add dsh-eia-review-plugin
```

## 配置

编辑 `cordis.patch.yml`：

```yaml
- insert:
    - id: eia-review
      name: 'dsh-eia-review-plugin'
      config:
        province: "zhejiang"      # 默认省份
        reviewMode: "both"        # eia | permit | both
        enableMCP: true
        strictMode: true
```

## 使用

在DSH Web UI中：

```
请对上传的环评报告进行技术审查
```

或调用工具：

```typescript
ctx.tools.call("eia_technical_review", {
  reportPath: "/path/to/report.pdf",
  reportType: "report_book",
  projectProvince: "zhejiang",
  industry: "C26-化学原料和化学制品制造业"
})
```

## 目录结构

```
dsh-eia-review-plugin/
├── src/
│   ├── core/              # 国家通用规则引擎（20条规则）
│   ├── provinces/         # 省级规则包
│   │   ├── zhejiang/      # 浙江省规则（基于2026年汇编）
│   │   └── _template/     # 其他省份接入模板
│   ├── parsers/           # PDF/Word文档解析
│   ├── mcp/               # MCP知识库客户端
│   └── index.ts           # 插件入口
├── skills/                # Agent Skills
├── knowledge/             # 内置知识库
├── cordis.patch.yml       # DSH插件配置
└── preset.yml             # Agent预设
```

## 开发

```bash
pnpm install
pnpm run build
pnpm dsh web --patch ./cordis.patch.yml
```

## 许可证

MIT

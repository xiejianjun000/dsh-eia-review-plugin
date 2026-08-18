import type { Context } from "@deepseek-ai/cordis"
import { defineTool } from "@deepseek-ai/dsh-tools"
import { NationalRuleEngine } from "./core/engine"
import { ProvincialRegistry } from "./provinces/registry"
import { DocumentParser } from "./parsers/document-parser"
import { MCPKnowledgeClient } from "./mcp/client"

export const name = "dsh-eia-review-plugin"
export const inject = ["tools", "llm", "skills"]

export interface Config {
  province?: string
  reviewMode: "eia" | "permit" | "both"
  enableMCP: boolean
  strictMode: boolean
  mcpConfig?: {
    serverName: string
    transport: "stdio" | "streamable-http"
    command?: string
    args?: string[]
  }
}

export function apply(ctx: Context, config: Config) {
  const nationalEngine = new NationalRuleEngine()
  const provincialRegistry = new ProvincialRegistry()
  const parser = new DocumentParser()

  // 初始化 MCP 客户端（如果启用）
  let mcpClient: MCPKnowledgeClient | null = null
  if (config.enableMCP && config.mcpConfig) {
    mcpClient = new MCPKnowledgeClient(config.mcpConfig)
  }

  // ═══════════════════════════════════════════════════════════════════════
  // 工具1: 环评技术审查（增强版）
  // ═══════════════════════════════════════════════════════════════════════
  ctx.tools.register(defineTool({
    name: "eia_technical_review",
    description: "对建设项目环境影响评价报告书/表进行技术审查，输出问题清单与合规性结论。支持国家通用规则+省级规则+MCP知识库增强。",
    parameters: {
      reportPath: { type: "string", required: true, description: "环评报告文件路径(PDF/Word)" },
      reportType: { type: "string", required: true, enum: ["report_book", "report_table", "registration"], description: "报告书/报告表/登记表" },
      projectProvince: { type: "string", required: false, description: "项目所在省份代码，如zhejiang" },
      industry: { type: "string", required: false, description: "行业类别(GB/T4754)" }
    },
    output: {
      schema: {
        type: "object",
        properties: {
          pass: { type: "boolean" },
          score: { type: "number" },
          nationalIssues: { type: "array" },
          provincialIssues: { type: "array" },
          knowledgeRefs: { type: "array" },
          mcpEnhanced: { type: "boolean" },
          reviewTime: { type: "number" }
        }
      },
      render: (args, value) => [{
        type: "text",
        text: formatReviewResult(value, args.projectProvince || config.province || "national")
      }]
    },
    async execute(args, exec) {
      const startTime = Date.now()
      const doc = await parser.parse(args.reportPath)
      const effectiveProvince = args.projectProvince || config.province || "national"

      // 第一层：国家通用规则审查（保底60%准确率）
      const nationalResult = await nationalEngine.review(doc, {
        reportType: args.reportType,
        industry: args.industry,
        province: effectiveProvince,
        reviewType: "eia"
      })

      // 第二层：省级规则审查（+15~25%准确率）
      let provincialResult = { issues: [], score: 100 }
      if (effectiveProvince !== "national") {
        const provEngine = provincialRegistry.load(effectiveProvince)
        provincialResult = await provEngine.review(doc, {
          reportType: args.reportType,
          industry: args.industry,
          province: effectiveProvince
        })
      }

      // 第三层：MCP知识库增强（冲击95%）
      let allIssues = [...nationalResult.issues, ...provincialResult.issues]
      let mcpEnhanced = false

      if (config.enableMCP && mcpClient) {
        try {
          await mcpClient.connect()
          allIssues = await enhanceWithKnowledgeBase(mcpClient, allIssues, effectiveProvince)
          mcpEnhanced = true
        } catch (e) {
          console.warn(`[eia-review] MCP enhancement failed:`, e)
        }
      }

      // 严格模式：知识库无法确认则降级
      if (config.strictMode) {
        allIssues = allIssues.filter((i: any) => i.confidence >= 0.85)
      }

      const totalScore = Math.round(
        nationalResult.score * 0.7 + provincialResult.score * 0.3
      )

      const reviewTime = Date.now() - startTime

      return {
        pass: totalScore >= 85 && !allIssues.some((i: any) => i.severity === "critical"),
        score: totalScore,
        nationalIssues: nationalResult.issues,
        provincialIssues: provincialResult.issues,
        knowledgeRefs: [...new Set(allIssues.flatMap((i: any) => i.basis))],
        mcpEnhanced,
        reviewTime
      }
    }
  }))

  // ═══════════════════════════════════════════════════════════════════════
  // 工具2: 排污许可证技术审查（增强版）
  // ═══════════════════════════════════════════════════════════════════════
  ctx.tools.register(defineTool({
    name: "permit_technical_review",
    description: "对排污许可证申请材料进行技术审查，依据HJ 1299-2023等标准。支持全国通用+省级特色规则。",
    parameters: {
      applicationPath: { type: "string", required: true },
      reviewType: { type: "string", required: true, enum: ["formal", "substantive", "full"] },
      province: { type: "string", required: false }
    },
    output: { schema: { type: "object" }, render: () => [] },
    async execute(args, exec) {
      const doc = await parser.parse(args.applicationPath)
      const effectiveProvince = args.province || config.province || "national"

      const nationalResult = await nationalEngine.review(doc, {
        reportType: "permit",
        province: effectiveProvince,
        reviewType: "permit"
      })

      return {
        pass: nationalResult.score >= 85,
        score: nationalResult.score,
        issues: nationalResult.issues,
        knowledgeRefs: nationalResult.knowledgeRefs
      }
    }
  }))

  // ═══════════════════════════════════════════════════════════════════════
  // 工具3: 行业标准查询（新增）
  // ═══════════════════════════════════════════════════════════════════════
  ctx.tools.register(defineTool({
    name: "eia_industry_info",
    description: "查询行业环评/排污许可相关信息，包括特征污染物、适用标准、管理要求等。",
    parameters: {
      industryCode: { type: "string", required: true, description: "行业代码(GB/T4754)" },
      queryType: { type: "string", required: false, enum: ["eia", "permit", "standards", "all"], default: "all" }
    },
    output: {
      schema: { type: "object" },
      render: (args, value) => [{
        type: "text",
        text: formatIndustryInfo(value)
      }]
    },
    async execute(args, exec) {
      if (!mcpClient) {
        return { error: "MCP client not configured" }
      }

      try {
        await mcpClient.connect()
        return await mcpClient.getIndustryInfo(args.industryCode, args.queryType || "all")
      } catch (e) {
        return { error: `Failed to query industry info: ${e}` }
      }
    }
  }))

  // ═══════════════════════════════════════════════════════════════════════
  // 注册 Skill
  // ═══════════════════════════════════════════════════════════════════════
  ctx.skills?.register?.({
    name: "eia-review-expert",
    description: "环境影响评价技术审查专家，精通国家法规与省级政策，配备行业知识图谱和法规知识库",
    body: `你是环评技术审查专家，依据以下规则执行审查：
1. 优先执行国家通用规则（22条增强版规则，含行业数据库、标准API、危废DB、核算引擎）
2. 根据项目所在省份加载省级规则库
3. 对低置信度问题查询MCP知识库确认（向量检索+知识图谱+重排序）
4. 输出结构化审查报告：通过/不通过、得分、问题清单、法规依据、行业特征分析

特别注意事项：
- 2026年3月12日后项目必须引用《生态环境法典》
- 长江经济带项目必须论证负面清单符合性
- 化工/石化/钢铁等重点行业必须按审批原则论证
- 2025年9月后项目关注排污许可证质量提升要求
- 源强核算必须使用标准方法（物料衡算/类比/实测/产排污系数）
- 排放标准必须引用现行有效版本`
  })
}

// 知识库增强：对低置信度问题查询MCP
async function enhanceWithKnowledgeBase(client: MCPKnowledgeClient, issues: any[], province: string) {
  for (const issue of issues) {
    if (issue.confidence >= 0.85) continue

    try {
      const result = await client.search(
        `${issue.name} ${issue.description} 环评审查依据`,
        {
          topK: 3,
          filter: {
            level: issue.level === "provincial" ? "provincial" : "national",
            province: province !== "national" ? province : undefined
          }
        }
      )

      const best = result.documents?.[0]
      if (best && best.score > 0.88) {
        issue.confidence = 0.95
        issue.basis = [...(issue.basis || []), best.source]
        issue.knowledgeRef = best.article
      } else if (best && best.score > 0.75) {
        issue.confidence = 0.85
        issue.basis = [...(issue.basis || []), best.source]
      }
    } catch (e) {
      // MCP查询失败不影响主流程
    }
  }

  return issues
}

// 格式化审查结果
function formatReviewResult(value: any, province: string): string {
  const allIssues = [...(value.nationalIssues || []), ...(value.provincialIssues || [])]
  const critical = allIssues.filter((i: any) => i.severity === "critical").length
  const major = allIssues.filter((i: any) => i.severity === "major").length
  const minor = allIssues.filter((i: any) => i.severity === "minor").length

  let text = `## 环评技术审查结果\n\n`
  text += `**省份**: ${province === "national" ? "全国通用" : province}\n`
  text += `**结论**: ${value.pass ? "✅ 通过" : "❌ 不通过"}\n`
  text += `**得分**: ${value.score}/100\n`
  text += `**审查耗时**: ${value.reviewTime || "N/A"}ms\n`
  text += `**MCP增强**: ${value.mcpEnhanced ? "✅ 已启用" : "❌ 未启用"}\n`
  text += `**问题统计**: 🔴Critical ${critical} | 🟡Major ${major} | 🟢Minor ${minor}\n\n`

  if (allIssues.length > 0) {
    text += "### 问题清单\n\n"
    allIssues.forEach((issue: any, idx: number) => {
      const icon = issue.severity === "critical" ? "🔴" : issue.severity === "major" ? "🟡" : "🟢"
      text += `${idx + 1}. ${icon} **[${issue.level === "national" ? "国家" : "省级"}] ${issue.name}**\n`
      text += `   - 描述: ${issue.description}\n`
      text += `   - 详情: ${issue.detail}\n`
      text += `   - 位置: ${issue.location}\n`
      text += `   - 依据: ${issue.basis?.join("、") || "-"}\n`
      text += `   - 置信度: ${(issue.confidence * 100).toFixed(0)}%\n\n`
    })
  }

  return text
}

// 格式化行业信息
function formatIndustryInfo(info: any): string {
  if (info.error) return `## 行业信息查询\n\n❌ 错误: ${info.error}`

  let text = `## 行业信息: ${info.name} (${info.code})\n\n`

  if (info.keyPollutants) {
    text += `**特征污染物**: ${info.keyPollutants.join("、")}\n\n`
  }

  if (info.applicableStandards) {
    text += `**适用标准**: ${info.applicableStandards.join("、")}\n\n`
  }

  if (info.eiaRequirements) {
    text += `**环评要求**: ${info.eiaRequirements.join("、")}\n\n`
  }

  if (info.permitRequirements) {
    text += `**排污许可要求**: ${info.permitRequirements.join("、")}\n\n`
  }

  if (info.processes) {
    text += "**典型工艺**:\n\n"
    info.processes.forEach((p: any) => {
      text += `- ${p.name}\n`
      text += `  - 污染物: ${p.pollutants.map((pl: any) => `${pl.name}(${pl.typicalValue}${pl.unit})`).join("、")}\n`
      text += `  - 控制措施: ${p.controlMeasures.join("、")}\n\n`
    })
  }

  return text
}

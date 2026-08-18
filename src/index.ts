import type { Context } from "@deepseek-ai/cordis"
import { defineTool } from "@deepseek-ai/dsh-tools"
import { NationalRuleEngine } from "./core/engine"
import { ProvincialRegistry } from "./provinces/registry"
import { DocumentParser } from "./parsers/document-parser"

export const name = "dsh-eia-review-plugin"
export const inject = ["tools", "llm", "skills"]

export interface Config {
  province?: string
  reviewMode: "eia" | "permit" | "both"
  enableMCP: boolean
  strictMode: boolean
}

export function apply(ctx: Context, config: Config) {
  const nationalEngine = new NationalRuleEngine()
  const provincialRegistry = new ProvincialRegistry()
  const parser = new DocumentParser()

  // ═══════════════════════════════════════════════════════════════════════
  // 工具1: 环评技术审查
  // ═══════════════════════════════════════════════════════════════════════
  ctx.tools.register(defineTool({
    name: "eia_technical_review",
    description: "对建设项目环境影响评价报告书/表进行技术审查，输出问题清单与合规性结论。支持全国通用+省级规则。",
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
          knowledgeRefs: { type: "array" }
        }
      },
      render: (args, value) => [{
        type: "text",
        text: formatReviewResult(value, args.projectProvince || config.province || "national")
      }]
    },
    async execute(args, exec) {
      const doc = await parser.parse(args.reportPath)
      const effectiveProvince = args.projectProvince || config.province || "national"

      // 第一层：国家通用规则审查
      const nationalResult = await nationalEngine.review(doc, {
        reportType: args.reportType,
        industry: args.industry,
        province: effectiveProvince,
        reviewType: "eia"
      })

      // 第二层：省级规则审查
      let provincialResult = { issues: [], score: 100 }
      if (effectiveProvince !== "national") {
        const provEngine = provincialRegistry.load(effectiveProvince)
        provincialResult = await provEngine.review(doc, {
          reportType: args.reportType,
          industry: args.industry,
          province: effectiveProvince
        })
      }

      // 第三层：MCP知识库增强
      let allIssues = [...nationalResult.issues, ...provincialResult.issues]
      if (config.enableMCP) {
        allIssues = await enhanceWithKnowledgeBase(exec.tools, allIssues, effectiveProvince)
      }

      const totalScore = Math.round(
        nationalResult.score * 0.7 + provincialResult.score * 0.3
      )

      return {
        pass: totalScore >= 85 && !allIssues.some((i: any) => i.severity === "critical"),
        score: totalScore,
        nationalIssues: nationalResult.issues,
        provincialIssues: provincialResult.issues,
        knowledgeRefs: [...new Set(allIssues.flatMap((i: any) => i.basis))]
      }
    }
  }))

  // ═══════════════════════════════════════════════════════════════════════
  // 工具2: 排污许可证技术审查
  // ═══════════════════════════════════════════════════════════════════════
  ctx.tools.register(defineTool({
    name: "permit_technical_review",
    description: "对排污许可证申请材料进行技术审查，依据HJ 1299-2023等标准。",
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
  // 注册 Skill
  // ═══════════════════════════════════════════════════════════════════════
  ctx.skills?.register?.({
    name: "eia-review-expert",
    description: "环境影响评价技术审查专家，精通国家法规与省级政策",
    body: `你是环评技术审查专家，依据以下规则执行审查：
1. 优先执行国家通用规则（20条）
2. 根据项目所在省份加载省级规则
3. 对低置信度问题查询MCP知识库确认
4. 输出结构化审查报告：通过/不通过、得分、问题清单、法规依据`
  })
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
  text += `**问题统计**: 🔴Critical ${critical} | 🟡Major ${major} | 🟢Minor ${minor}\n\n`

  if (allIssues.length > 0) {
    text += `### 问题清单\n\n`
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

// MCP知识库增强
async function enhanceWithKnowledgeBase(tools: any[], issues: any[], province: string) {
  const kbTools = tools.filter((t: any) => t.name?.startsWith?.("mcp__eia-kb__"))
  if (kbTools.length === 0) return issues

  const searchTool = kbTools.find((t: any) => t.name?.includes?.("search"))
  if (!searchTool) return issues

  for (const issue of issues) {
    if (issue.confidence >= 0.85) continue

    try {
      const result = await searchTool.execute({
        query: `${issue.name} ${issue.description} 环评审查依据`,
        topK: 3,
        filter: {
          level: issue.level,
          province: province !== "national" ? province : undefined
        }
      })

      const best = result?.documents?.[0]
      if (best?.score > 0.88) {
        issue.confidence = 0.95
        issue.basis = [...(issue.basis || []), best.source]
      } else if (best?.score > 0.75) {
        issue.confidence = 0.85
      }
    } catch (e) {
      // MCP查询失败不影响主流程
    }
  }

  return issues
}

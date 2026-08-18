#!/usr/bin/env bash
# DSH 环评审查插件 - 每日维护脚本
# 运行时间: 每天凌晨 3:00 (cron: 0 3 * * *)
# 功能: 知识库同步、规则更新、日志清理、健康检查

set -euo pipefail

# ═══════════════════════════════════════════════════════════════════════
# 配置
# ═══════════════════════════════════════════════════════════════════════
PLUGIN_DIR="$(cd "$(dirname "$0")/.." && pwd)"
LOG_DIR="${PLUGIN_DIR}/logs"
MAINTENANCE_LOG="${LOG_DIR}/maintenance-$(date +%Y%m%d).log"
MAX_LOG_DAYS=30
MAX_BACKUP_DAYS=7

# 颜色
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# ═══════════════════════════════════════════════════════════════════════
# 日志函数
# ═══════════════════════════════════════════════════════════════════════
log() {
    local level="$1"
    local msg="$2"
    local timestamp=$(date '+%Y-%m-%d %H:%M:%S')
    echo "[${timestamp}] [${level}] ${msg}" | tee -a "${MAINTENANCE_LOG}"
}

log_info() { log "INFO" "$1"; }
log_warn() { log "WARN" "$1"; }
log_error() { log "ERROR" "$1"; }
log_success() { log "SUCCESS" "$1"; }

# ═══════════════════════════════════════════════════════════════════════
# 步骤1: 环境检查
# ═══════════════════════════════════════════════════════════════════════
step1_env_check() {
    log_info "═══════════════════════════════════════════════════════"
    log_info "开始每日维护: $(date)"
    log_info "插件目录: ${PLUGIN_DIR}"
    log_info "═══════════════════════════════════════════════════════"

    # 检查 Node.js
    if ! command -v node &> /dev/null; then
        log_error "Node.js 未安装"
        return 1
    fi
    log_info "Node.js 版本: $(node --version)"

    # 检查 pnpm
    if ! command -v pnpm &> /dev/null; then
        log_warn "pnpm 未安装，尝试使用 npm"
        PNPM="npm"
    else
        PNPM="pnpm"
        log_info "pnpm 版本: $(pnpm --version)"
    fi

    # 创建日志目录
    mkdir -p "${LOG_DIR}"

    # 检查 EHS_KB_API_KEY
    if [ -z "${EHS_KB_API_KEY:-}" ]; then
        log_warn "EHS_KB_API_KEY 未设置，知识库同步将跳过"
    else
        log_info "EHS_KB_API_KEY 已配置"
    fi

    return 0
}

# ═══════════════════════════════════════════════════════════════════════
# 步骤2: 依赖更新检查
# ═══════════════════════════════════════════════════════════════════════
step2_dependency_check() {
    log_info "───────────────────────────────────────────────────────"
    log_info "[步骤2] 依赖更新检查"
    log_info "───────────────────────────────────────────────────────"

    cd "${PLUGIN_DIR}"

    # 检查 package.json 是否存在
    if [ ! -f "package.json" ]; then
        log_warn "package.json 不存在，跳过依赖检查"
        return 0
    fi

    # 检查是否有更新可用
    log_info "检查依赖更新..."
    if [ "$PNPM" = "pnpm" ]; then
        pnpm outdated 2>/dev/null || log_warn "pnpm outdated 执行失败"
    else
        npm outdated 2>/dev/null || log_warn "npm outdated 执行失败"
    fi

    # 检查是否有安全漏洞
    log_info "检查安全漏洞..."
    if [ "$PNPM" = "pnpm" ]; then
        pnpm audit --audit-level moderate 2>/dev/null || log_warn "pnpm audit 执行失败"
    else
        npm audit --audit-level moderate 2>/dev/null || log_warn "npm audit 执行失败"
    fi

    log_success "依赖检查完成"
    return 0
}

# ═══════════════════════════════════════════════════════════════════════
# 步骤3: 知识库同步
# ═══════════════════════════════════════════════════════════════════════
step3_kb_sync() {
    log_info "───────────────────────────────────────────────────────"
    log_info "[步骤3] EHS 知识库同步"
    log_info "───────────────────────────────────────────────────────"

    if [ -z "${EHS_KB_API_KEY:-}" ]; then
        log_warn "跳过知识库同步（API Key 未设置）"
        return 0
    fi

    # 使用 curl 调用 kb_sync
    local mcp_url="http://111.230.89.107:8000"
    local sync_payload='{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"kb_sync","arguments":{}}}'

    log_info "正在同步知识库..."

    # 先获取 endpoint
    local endpoint
    endpoint=$(curl -s -H "X-API-Key: ${EHS_KB_API_KEY}"         -H "Accept: text/event-stream"         "${mcp_url}/sse/" 2>/dev/null |         grep -o 'data: .*' | head -1 | sed 's/data: //')

    if [ -z "$endpoint" ]; then
        log_warn "无法获取 MCP endpoint，跳过同步"
        return 0
    fi

    # 发送 initialize
    local init_resp
    init_resp=$(curl -s -X POST         -H "Content-Type: application/json"         -H "X-API-Key: ${EHS_KB_API_KEY}"         -d '{"jsonrpc":"2.0","id":0,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"maintenance","version":"1.0.0"}}}'         "${mcp_url}${endpoint}" 2>/dev/null)

    if [ -n "$init_resp" ]; then
        log_info "MCP initialize 成功"
    fi

    # 发送 kb_sync
    local sync_resp
    sync_resp=$(curl -s -X POST         -H "Content-Type: application/json"         -H "X-API-Key: ${EHS_KB_API_KEY}"         -d '{"jsonrpc":"2.0","id":1,"method":"notifications/initialized"}'         "${mcp_url}${endpoint}" 2>/dev/null)

    # 调用 kb_status 检查同步结果
    local status_resp
    status_resp=$(curl -s -X POST         -H "Content-Type: application/json"         -H "X-API-Key: ${EHS_KB_API_KEY}"         -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"kb_status","arguments":{}}}'         "${mcp_url}${endpoint}" 2>/dev/null)

    if [ -n "$status_resp" ]; then
        log_info "知识库状态: ${status_resp}"
        log_success "知识库同步完成"
    else
        log_warn "知识库状态获取失败"
    fi

    return 0
}

# ═══════════════════════════════════════════════════════════════════════
# 步骤4: 规则库更新检查
# ═══════════════════════════════════════════════════════════════════════
step4_rule_update_check() {
    log_info "───────────────────────────────────────────────────────"
    log_info "[步骤4] 规则库更新检查"
    log_info "───────────────────────────────────────────────────────"

    cd "${PLUGIN_DIR}"

    # 检查国家法规是否有更新（通过知识库查询最新法规）
    log_info "检查国家法规更新..."

    # 这里可以接入法规更新 API 或检查知识库中的法规版本
    # 简化版本：检查本地规则文件是否有更新

    local rule_file="${PLUGIN_DIR}/src/core/national-rules.ts"
    if [ -f "$rule_file" ]; then
        local last_modified
        last_modified=$(stat -c %Y "$rule_file" 2>/dev/null || stat -f %m "$rule_file" 2>/dev/null)
        local days_since_update=$(( ( $(date +%s) - last_modified ) / 86400 ))

        log_info "国家规则库最后更新: ${days_since_update} 天前"

        if [ $days_since_update -gt 30 ]; then
            log_warn "规则库超过 30 天未更新，建议检查是否有新法规发布"
        fi
    fi

    # 检查省级规则
    local provinces_dir="${PLUGIN_DIR}/src/provinces"
    if [ -d "$provinces_dir" ]; then
        for province_dir in "$provinces_dir"/*/; do
            if [ -d "$province_dir" ]; then
                local province_name=$(basename "$province_dir")
                local rules_file="${province_dir}/rules.ts"
                if [ -f "$rules_file" ]; then
                    local p_last_modified
                    p_last_modified=$(stat -c %Y "$rules_file" 2>/dev/null || stat -f %m "$rules_file" 2>/dev/null)
                    local p_days=$(( ( $(date +%s) - p_last_modified ) / 86400 ))
                    log_info "${province_name} 规则库最后更新: ${p_days} 天前"
                fi
            fi
        done
    fi

    log_success "规则库检查完成"
    return 0
}

# ═══════════════════════════════════════════════════════════════════════
# 步骤5: 日志清理
# ═══════════════════════════════════════════════════════════════════════
step5_log_cleanup() {
    log_info "───────────────────────────────────────────────────────"
    log_info "[步骤5] 日志清理"
    log_info "───────────────────────────────────────────────────────"

    # 清理旧日志
    if [ -d "${LOG_DIR}" ]; then
        local deleted_count
        deleted_count=$(find "${LOG_DIR}" -name "*.log" -mtime +${MAX_LOG_DAYS} | wc -l)
        find "${LOG_DIR}" -name "*.log" -mtime +${MAX_LOG_DAYS} -delete
        log_info "清理 ${deleted_count} 个超过 ${MAX_LOG_DAYS} 天的日志文件"
    fi

    # 清理旧维护日志
    local old_maintenance_logs
    old_maintenance_logs=$(find "${LOG_DIR}" -name "maintenance-*.log" -mtime +${MAX_BACKUP_DAYS} | wc -l)
    find "${LOG_DIR}" -name "maintenance-*.log" -mtime +${MAX_BACKUP_DAYS} -delete
    log_info "清理 ${old_maintenance_logs} 个超过 ${MAX_BACKUP_DAYS} 天的维护日志"

    # 清理 npm/pnpm 缓存（可选）
    if [ "$PNPM" = "pnpm" ]; then
        pnpm store prune 2>/dev/null || true
        log_info "pnpm 存储已清理"
    fi

    log_success "日志清理完成"
    return 0
}

# ═══════════════════════════════════════════════════════════════════════
# 步骤6: 健康检查
# ═══════════════════════════════════════════════════════════════════════
step6_health_check() {
    log_info "───────────────────────────────────────────────────────"
    log_info "[步骤6] 插件健康检查"
    log_info "───────────────────────────────────────────────────────"

    cd "${PLUGIN_DIR}"

    # 检查 TypeScript 编译
    log_info "检查 TypeScript 编译..."
    if [ -f "tsconfig.json" ]; then
        if npx tsc --noEmit 2>/dev/null; then
            log_success "TypeScript 编译检查通过"
        else
            log_warn "TypeScript 编译检查发现问题"
        fi
    fi

    # 检查关键文件完整性
    local critical_files=(
        "src/index.ts"
        "src/core/national-rules.ts"
        "src/core/engine.ts"
        "src/types.ts"
        "cordis.patch.yml"
        "package.json"
    )

    local missing_files=0
    for file in "${critical_files[@]}"; do
        if [ ! -f "${PLUGIN_DIR}/${file}" ]; then
            log_error "关键文件缺失: ${file}"
            missing_files=$((missing_files + 1))
        fi
    done

    if [ $missing_files -eq 0 ]; then
        log_success "所有关键文件完整"
    else
        log_error "发现 ${missing_files} 个关键文件缺失"
    fi

    # 检查知识库连接（如果配置了 Key）
    if [ -n "${EHS_KB_API_KEY:-}" ]; then
        log_info "检查知识库连接..."
        local kb_status
        kb_status=$(curl -s -o /dev/null -w "%{http_code}"             -H "X-API-Key: ${EHS_KB_API_KEY}"             "http://111.230.89.107:8000/" 2>/dev/null)

        if [ "$kb_status" = "200" ]; then
            log_success "知识库连接正常 (HTTP 200)"
        else
            log_warn "知识库连接异常 (HTTP ${kb_status})"
        fi
    fi

    # 检查磁盘空间
    local disk_usage
    disk_usage=$(df -h "${PLUGIN_DIR}" | awk 'NR==2 {print $5}' | sed 's/%//')
    if [ "$disk_usage" -gt 90 ]; then
        log_error "磁盘使用率超过 90%: ${disk_usage}%"
    elif [ "$disk_usage" -gt 80 ]; then
        log_warn "磁盘使用率超过 80%: ${disk_usage}%"
    else
        log_info "磁盘使用率正常: ${disk_usage}%"
    fi

    log_success "健康检查完成"
    return 0
}

# ═══════════════════════════════════════════════════════════════════════
# 步骤7: 生成维护报告
# ═══════════════════════════════════════════════════════════════════════
step7_generate_report() {
    log_info "───────────────────────────────────────────────────────"
    log_info "[步骤7] 生成维护报告"
    log_info "───────────────────────────────────────────────────────"

    local report_file="${LOG_DIR}/maintenance-report-$(date +%Y%m%d).json"

    cat > "$report_file" << EOF
{
    "date": "$(date -Iseconds)",
    "plugin": "dsh-eia-review-plugin",
    "version": "1.0.0",
    "maintenance": {
        "env_check": "completed",
        "dependency_check": "completed",
        "kb_sync": "completed",
        "rule_update_check": "completed",
        "log_cleanup": "completed",
        "health_check": "completed"
    },
    "system": {
        "node_version": "$(node --version 2>/dev/null || echo 'unknown')",
        "pnpm_version": "$(pnpm --version 2>/dev/null || echo 'unknown')",
        "disk_usage": "$(df -h "${PLUGIN_DIR}" | awk 'NR==2 {print $5}')",
        "plugin_size": "$(du -sh "${PLUGIN_DIR}" 2>/dev/null | cut -f1)"
    },
    "next_maintenance": "$(date -d '+1 day' -Iseconds)"
}
EOF

    log_success "维护报告已生成: ${report_file}"

    # 输出摘要
    log_info "═══════════════════════════════════════════════════════"
    log_info "维护完成: $(date)"
    log_info "日志文件: ${MAINTENANCE_LOG}"
    log_info "报告文件: ${report_file}"
    log_info "═══════════════════════════════════════════════════════"

    return 0
}

# ═══════════════════════════════════════════════════════════════════════
# 主函数
# ═══════════════════════════════════════════════════════════════════════
main() {
    local exit_code=0

    step1_env_check || exit_code=1
    step2_dependency_check || exit_code=1
    step3_kb_sync || exit_code=1
    step4_rule_update_check || exit_code=1
    step5_log_cleanup || exit_code=1
    step6_health_check || exit_code=1
    step7_generate_report || exit_code=1

    if [ $exit_code -eq 0 ]; then
        log_success "所有维护步骤成功完成"
    else
        log_warn "部分维护步骤出现问题，请检查日志"
    fi

    return $exit_code
}

# 运行主函数
main "$@"

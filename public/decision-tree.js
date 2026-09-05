/**
 * DecisionTree - Interactive visualization for crypto signal analysis pipeline
 * Renders a horizontal flow diagram showing 5 analysis stages with status indicators
 */
class DecisionTree {
    constructor(containerElement) {
        this.container = containerElement;
        this.container.classList.add('decision-tree-container');

        // Pipeline stages configuration
        this.stages = [
            { id: 'monthly_bias', label: 'Monthly Bias', type: 'bias', values: ['BULLISH', 'BEARISH', 'NEUTRO'] },
            { id: 'weekly_structure', label: 'Weekly Structure', type: 'structure', values: ['ALTA', 'BAIXA', 'LATERAL'] },
            { id: 'daily_regime', label: 'Daily Regime', type: 'regime', values: ['BULLISH', 'BEARISH'] },
            { id: 'h4_setup', label: '4H Setup', type: 'setup', values: ['TREND_PULLBACK', 'BREAKOUT_VOLUME', 'SQUEEZE_BREAKOUT', 'none'] },
            { id: 'h1_trigger', label: '1H Trigger', type: 'trigger', values: ['COMPRA', 'VENDA', 'NEUTRO'] }
        ];

        // Status configuration
        this.readinessStatuses = ['CONFIRMADO', 'ARMADO', 'EM_FORMAÇÃO', 'NEUTRO'];

        // Create main structure
        this.createStructure();
    }

    createStructure() {
        // Wrapper for the entire widget
        this.wrapper = document.createElement('div');
        this.wrapper.className = 'decision-tree-wrapper';

        // Create SVG container for flow diagram
        this.svgContainer = document.createElement('div');
        this.svgContainer.className = 'decision-tree-svg-container';

        // Create summary bar
        this.summaryBar = document.createElement('div');
        this.summaryBar.className = 'decision-tree-summary';

        // Create legend
        this.legend = document.createElement('div');
        this.legend.className = 'decision-tree-legend';

        this.wrapper.appendChild(this.svgContainer);
        this.wrapper.appendChild(this.summaryBar);
        this.wrapper.appendChild(this.legend);
        this.container.appendChild(this.wrapper);

        this.createLegend();
    }

    createLegend() {
        this.legend.innerHTML = `
            <div class="legend-item">
                <span class="legend-color bullish"></span>
                <span class="legend-label">Bullish/Long</span>
            </div>
            <div class="legend-item">
                <span class="legend-color bearish"></span>
                <span class="legend-label">Bearish/Short</span>
            </div>
            <div class="legend-item">
                <span class="legend-color neutral"></span>
                <span class="legend-label">Neutral</span>
            </div>
            <div class="legend-item">
                <span class="legend-color in-progress"></span>
                <span class="legend-label">In Progress</span>
            </div>
        `;
    }

    update(analysisData) {
        if (!analysisData) {
            this.clear();
            return;
        }

        // Extract status for each stage
        const stageStatuses = this.extractStageStatuses(analysisData);

        // Render SVG flow diagram
        this.renderFlowDiagram(stageStatuses);

        // Render summary bar
        this.renderSummary(analysisData, stageStatuses);
    }

    extractStageStatuses(data) {
        const statuses = [];

        // Monthly Bias
        const monthlyBias = data.monthly_bias || data.monthlyBias || 'NEUTRO';
        statuses.push({
            value: monthlyBias.toUpperCase(),
            status: this.getBiasStatus(monthlyBias, 'bias'),
            adx: null
        });

        // Weekly Structure
        const weeklyStructure = data.weekly_structure || data.weeklyStructure || 'LATERAL';
        statuses.push({
            value: weeklyStructure.toUpperCase(),
            status: this.getBiasStatus(weeklyStructure, 'structure'),
            adx: null
        });

        // Daily Regime
        const dailyRegime = data.daily_regime || data.dailyRegime || 'NEUTRO';
        const adx = data.adx || data.adxValue || null;
        statuses.push({
            value: dailyRegime.toUpperCase(),
            status: this.getRegimeStatus(dailyRegime),
            adx: adx
        });

        // 4H Setup
        const h4Setup = data.h4_setup || data.h4Setup || data.four_hour_setup || 'none';
        statuses.push({
            value: h4Setup === 'none' ? 'NONE' : h4Setup.toUpperCase(),
            status: this.getSetupStatus(h4Setup),
            adx: null
        });

        // 1H Trigger
        const h1Trigger = data.h1_trigger || data.h1Trigger || 'NEUTRO';
        statuses.push({
            value: h1Trigger.toUpperCase(),
            status: this.getTriggerStatus(h1Trigger),
            adx: null
        });

        return statuses;
    }

    getBiasStatus(value, type) {
        const v = value.toUpperCase();
        if (type === 'bias') {
            if (v === 'BULLISH') return 'confirmed';
            if (v === 'BEARISH') return 'blocked';
            return 'neutral';
        }
        if (type === 'structure') {
            if (v === 'ALTA') return 'confirmed';
            if (v === 'BAIXA') return 'blocked';
            return 'neutral';
        }
        return 'neutral';
    }

    getRegimeStatus(value) {
        const v = value.toUpperCase();
        if (v === 'BULLISH') return 'confirmed';
        if (v === 'BEARISH') return 'blocked';
        return 'neutral';
    }

    getSetupStatus(value) {
        const v = value.toLowerCase();
        if (v === 'none' || v === '') return 'neutral';
        return 'confirmed';
    }

    getTriggerStatus(value) {
        const v = value.toUpperCase();
        if (v === 'COMPRA') return 'confirmed';
        if (v === 'VENDA') return 'blocked';
        return 'neutral';
    }

    getStatusColor(status) {
        switch (status) {
            case 'confirmed': return 'var(--dt-color-bullish)';
            case 'blocked': return 'var(--dt-color-bearish)';
            case 'in-progress': return 'var(--dt-color-warning)';
            default: return 'var(--dt-color-neutral)';
        }
    }

    getStatusGlow(status) {
        switch (status) {
            case 'confirmed': return 'var(--dt-glow-bullish)';
            case 'blocked': return 'var(--dt-glow-bearish)';
            case 'in-progress': return 'var(--dt-glow-warning)';
            default: return 'none';
        }
    }

    renderFlowDiagram(stageStatuses) {
        const nodeWidth = 120;
        const nodeHeight = 80;
        const nodeSpacing = 50;
        const paddingX = 20;
        const paddingY = 20;
        const totalWidth = paddingX * 2 + this.stages.length * nodeWidth + (this.stages.length - 1) * nodeSpacing;
        const totalHeight = paddingY * 2 + nodeHeight + 40; // extra space for ADX labels
        const startX = paddingX;
        const startY = paddingY + 10;

        let svg = `<svg class="decision-tree-svg" viewBox="0 0 ${totalWidth} ${totalHeight}" xmlns="http://www.w3.org/2000/svg">`;

        // Defs: arrowhead marker and glow filter
        svg += `
            <defs>
                <marker id="dt-arrow" markerWidth="10" markerHeight="7" refX="10" refY="3.5" orient="auto">
                    <polygon points="0 0, 10 3.5, 0 7" fill="#555" />
                </marker>
                <filter id="dt-glow-green" x="-40%" y="-40%" width="180%" height="180%">
                    <feGaussianBlur stdDeviation="5" result="blur" />
                    <feFlood flood-color="#00ff88" flood-opacity="0.6" result="color" />
                    <feComposite in="color" in2="blur" operator="in" result="shadow" />
                    <feMerge>
                        <feMergeNode in="shadow" />
                        <feMergeNode in="SourceGraphic" />
                    </feMerge>
                </filter>
                <filter id="dt-glow-red" x="-40%" y="-40%" width="180%" height="180%">
                    <feGaussianBlur stdDeviation="5" result="blur" />
                    <feFlood flood-color="#ff4444" flood-opacity="0.6" result="color" />
                    <feComposite in="color" in2="blur" operator="in" result="shadow" />
                    <feMerge>
                        <feMergeNode in="shadow" />
                        <feMergeNode in="SourceGraphic" />
                    </feMerge>
                </filter>
            </defs>
        `;

        // Render connection arrows first (behind nodes)
        for (let i = 0; i < this.stages.length - 1; i++) {
            const x1 = startX + i * (nodeWidth + nodeSpacing) + nodeWidth;
            const x2 = startX + (i + 1) * (nodeWidth + nodeSpacing);
            const arrowY = startY + nodeHeight / 2;

            // Check if any prior stage is blocked; if so, dim the arrow
            const priorBlocked = stageStatuses.slice(0, i + 1).some(s => s.status === 'blocked');
            const arrowOpacity = priorBlocked ? '0.3' : '1';

            svg += `<line
                x1="${x1}" y1="${arrowY}"
                x2="${x2 - 2}" y2="${arrowY}"
                stroke="#555"
                stroke-width="2"
                stroke-dasharray="${priorBlocked ? '6,4' : 'none'}"
                opacity="${arrowOpacity}"
                marker-end="url(#dt-arrow)"
                class="decision-tree-arrow"
            />`;
        }

        // Render each stage node
        this.stages.forEach((stage, index) => {
            const x = startX + index * (nodeWidth + nodeSpacing);
            const y = startY;
            const status = stageStatuses[index];
            const color = this.getStatusColor(status.status);

            // Determine glow filter
            let filterAttr = '';
            if (status.status === 'confirmed') {
                filterAttr = 'filter="url(#dt-glow-green)"';
            } else if (status.status === 'blocked') {
                filterAttr = 'filter="url(#dt-glow-red)"';
            }

            // Determine stroke color based on status
            const strokeColor = status.status === 'confirmed' ? '#00ff88'
                : status.status === 'blocked' ? '#ff4444'
                : status.status === 'in-progress' ? '#ffaa00'
                : '#4488ff';

            const nodeClass = `decision-tree-node dt-status-${status.status}`;

            svg += `<g class="${nodeClass}" ${filterAttr}>`;

            // Glass morphism background
            svg += `<rect
                x="${x}" y="${y}"
                width="${nodeWidth}" height="${nodeHeight}"
                rx="12" ry="12"
                fill="rgba(20, 20, 40, 0.85)"
                stroke="${strokeColor}"
                stroke-width="2"
                class="node-rect"
            />`;

            // Glass highlight (top half reflection)
            svg += `<rect
                x="${x + 1}" y="${y + 1}"
                width="${nodeWidth - 2}" height="${nodeHeight / 2 - 1}"
                rx="11" ry="11"
                fill="url(#dt-glass-gradient-${index})"
                opacity="0.12"
                class="node-glass"
            />`;

            // Stage label (small text at top)
            svg += `<text
                x="${x + nodeWidth / 2}"
                y="${y + 18}"
                text-anchor="middle"
                class="node-label"
                fill="#888"
                font-size="10"
            >${stage.label}</text>`;

            // Status value (bold center text)
            svg += `<text
                x="${x + nodeWidth / 2}"
                y="${y + 48}"
                text-anchor="middle"
                class="node-value"
                fill="${strokeColor}"
                font-size="12"
                font-weight="bold"
            >${this.truncateValue(status.value)}</text>`;

            // ADX indicator for Daily Regime
            if (status.adx !== null && status.adx !== undefined) {
                svg += `<text
                    x="${x + nodeWidth / 2}"
                    y="${y + 66}"
                    text-anchor="middle"
                    class="node-adx"
                    fill="#666"
                    font-size="9"
                >ADX: ${status.adx}</text>`;
            }

            // Bottom status indicator bar
            const indicatorWidth = 60;
            const indicatorHeight = 3;
            const indicatorX = x + (nodeWidth - indicatorWidth) / 2;
            const indicatorY = y + nodeHeight - 10;

            svg += `<rect
                x="${indicatorX}" y="${indicatorY}"
                width="${indicatorWidth}" height="${indicatorHeight}"
                rx="1.5" ry="1.5"
                fill="${strokeColor}"
                opacity="0.6"
            />`;

            // Checkmark overlay for confirmed stages
            if (status.status === 'confirmed') {
                const cx = x + nodeWidth - 18;
                const cy = y + 14;
                svg += `<polyline
                    points="${cx},${cy + 5} ${cx + 4},${cy + 10} ${cx + 11},${cy}"
                    fill="none"
                    stroke="#00ff88"
                    stroke-width="2.5"
                    stroke-linecap="round"
                    stroke-linejoin="round"
                    class="node-check"
                />`;
            }

            // X overlay for blocked stages
            if (status.status === 'blocked') {
                const cx = x + nodeWidth - 16;
                const cy = y + 12;
                const sz = 10;
                svg += `<g class="node-cross" stroke="#ff4444" stroke-width="2.5" stroke-linecap="round">
                    <line x1="${cx}" y1="${cy}" x2="${cx + sz}" y2="${cy + sz}" />
                    <line x1="${cx + sz}" y1="${cy}" x2="${cx}" y2="${cy + sz}" />
                </g>`;
            }

            // In-progress spinner indicator
            if (status.status === 'in-progress') {
                svg += `<circle
                    cx="${x + nodeWidth - 16}" cy="${y + 18}" r="6"
                    fill="none"
                    stroke="#ffaa00"
                    stroke-width="2"
                    stroke-dasharray="20"
                    stroke-dashoffset="5"
                    class="node-spinner"
                />`;
            }

            svg += `</g>`;
        });

        svg += `</svg>`;

        this.svgContainer.innerHTML = svg;
    }

    truncateValue(value) {
        // Truncate long values to fit inside the node
        if (value.length > 14) {
            return value.substring(0, 12) + '...';
        }
        return value;
    }

    renderSummary(data, stageStatuses) {
        const readiness = this.calculateReadiness(stageStatuses);
        const readinessStatus = this.getReadinessStatus(readiness);
        const missingConfluences = this.findMissingConfluences(stageStatuses);

        // Determine readiness bar color class
        let readinessClass = 'readiness-neutral';
        if (readinessStatus === 'CONFIRMADO') readinessClass = 'readiness-confirmed';
        else if (readinessStatus === 'ARMADO') readinessClass = 'readiness-armed';
        else if (readinessStatus === 'EM_FORMAÇÃO') readinessClass = 'readiness-forming';

        let html = `<div class="summary-content">`;

        // Main readiness row
        html += `
            <div class="readiness-row">
                <div class="readiness-label-block">
                    <span class="readiness-label">SIGNAL READINESS</span>
                </div>
                <div class="readiness-bar-track">
                    <div class="readiness-bar-fill ${readinessClass}" style="width: ${Math.round(readiness)}%"></div>
                </div>
                <div class="readiness-value-block">
                    <span class="readiness-status-badge ${readinessClass}">${readinessStatus}</span>
                    <span class="readiness-pct">${Math.round(readiness)}%</span>
                </div>
            </div>
        `;

        // Stage breakdown row
        html += `<div class="stage-breakdown">`;
        stageStatuses.forEach((status, index) => {
            const stageName = this.stages[index].label;
            const icon = status.status === 'confirmed' ? '&#10003;'
                : status.status === 'blocked' ? '&#10007;'
                : status.status === 'in-progress' ? '&#9881;'
                : '&#8212;';
            const iconClass = `breakdown-icon status-${status.status}`;

            html += `<div class="breakdown-item ${status.status}">
                <span class="${iconClass}">${icon}</span>
                <span class="breakdown-label">${stageName}</span>
            </div>`;
        });
        html += `</div>`;

        // Missing confluences
        if (missingConfluences.length > 0) {
            html += `
                <div class="missing-confluences">
                    <span class="missing-label">Missing:</span>
                    <span class="missing-list">${missingConfluences.join(' / ')}</span>
                </div>
            `;
        }

        html += `</div>`;

        this.summaryBar.innerHTML = html;
    }

    calculateReadiness(stageStatuses) {
        // Weighted scoring: earlier stages are more important for overall signal quality
        const weights = [0.25, 0.25, 0.20, 0.15, 0.15];
        let totalWeight = 0;
        let achievedWeight = 0;

        stageStatuses.forEach((status, index) => {
            totalWeight += weights[index];
            if (status.status === 'confirmed') {
                achievedWeight += weights[index];
            } else if (status.status === 'in-progress') {
                achievedWeight += weights[index] * 0.5;
            }
            // blocked and neutral contribute 0
        });

        return totalWeight > 0 ? (achievedWeight / totalWeight) * 100 : 0;
    }

    getReadinessStatus(readiness) {
        if (readiness >= 90) return 'CONFIRMADO';
        if (readiness >= 70) return 'ARMADO';
        if (readiness >= 40) return 'EM_FORMACAO';
        return 'NEUTRO';
    }

    findMissingConfluences(stageStatuses) {
        const missing = [];
        stageStatuses.forEach((status, index) => {
            if (status.status !== 'confirmed') {
                missing.push(this.stages[index].label);
            }
        });
        return missing;
    }

    clear() {
        if (this.svgContainer) this.svgContainer.innerHTML = '';
        if (this.summaryBar) this.summaryBar.innerHTML = '';
    }
}

// Export for module usage
if (typeof module !== 'undefined' && module.exports) {
    module.exports = DecisionTree;
}

// Make available globally for vanilla JS usage
if (typeof window !== 'undefined') {
    window.DecisionTree = DecisionTree;
}

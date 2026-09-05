const app = {
    token: localStorage.getItem('alpha_token'),
    activeSymbol: 'BTCUSDT',
    chart: null,
    candleSeries: null,
    latestAnalysis: null,
    analysisController: null,
    chartTimeframe: '4h',
    chartTools: { ema: true, bollinger: false, volume: true, pivots: true, levels: true, fibo: false, vwap: false, poc: false, risk: false, channel: false, liquidity: false, blocks: false },
    overlaySeries: [],
    chartPriceLines: [],
    lastLivePrice: null,
    drawingMode: null,
    drawingPoints: [],
    manualSeries: [],
    manualPriceLines: [],
    drawingSnap: true,
    currentChartCandles: [],
    symbols: [],
    knownTriggeredAlerts: new Set(),
    alertsInitialized: false,
    extraOpportunities: [],
    lastExtraScanAt: 0,
    knownSignalIds: new Set(),
    eventsInitialized: false,
    chartLogarithmic: false,
    chartGridVisible: true,
    chartFocused: false,

    async init() {
        await this.restoreSession();
        this.configureLogin();
        this.setupTabs();
        this.initChart();
        
        // v2.0: Initialize Decision Tree
        const treeContainer = document.getElementById("signal-tree");
        if (treeContainer && typeof DecisionTree !== "undefined") {
            this.decisionTree = new DecisionTree(treeContainer);
        }
        this.bindChartControls();
        this.loadSymbol(this.activeSymbol);
        this.updatePerf();
        this.updateEngineStatus();
        this.loadAutomation();
        if (this.token) this.loadAlerts();
        if (this.token) this.loadEvents();
        if (this.token) this.loadJournal();
        setInterval(() => this.updatePerf(), 10000);
        setInterval(() => this.loadSymbol(this.activeSymbol, true), 60000);
        setInterval(() => { if (this.token) this.loadAlerts(true); }, 15000);
        setInterval(() => this.loadAutomation(true), 15000);
        setInterval(() => this.loadLivePrice(), 5000);
        setInterval(() => { if (this.token) this.loadEvents(true); }, 15000);
        setInterval(() => { if (this.token) this.loadJournal(true); }, 30000);
    },

    async login() {
        const pass = document.getElementById('login-pass').value.trim();
        const button = document.getElementById('login-btn'); const error = document.getElementById('login-error');
        error.classList.add('hidden'); button.disabled = true; button.innerText = 'Validando…';
        try {
            const res = await fetch('/api/auth/login', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ password: pass })
            });
            const data = await res.json();
            if (res.ok && data.success) {
                this.completeLogin(data.token);
            } else {
                error.innerText = data.error || 'Chave de acesso inválida';
                error.classList.remove('hidden');
            }
        } catch (e) {
            error.innerText = 'Servidor indisponível. Aguarde alguns segundos e tente novamente.';
            error.classList.remove('hidden');
        } finally { button.disabled = false; button.innerText = 'Acessar terminal'; }
    },

    async configureLogin() {
        try {
            const health = await (await fetch('/api/health', { cache: 'no-store' })).json();
            document.getElementById('demo-login-btn').classList.toggle('hidden', !health.demoMode);
            if (health.demoMode) document.getElementById('login-help').innerText = 'Use a senha de acesso ou entre diretamente no ambiente demonstrativo.';
        } catch (error) {}
    },

    completeLogin(token) {
        this.token = token; localStorage.setItem('alpha_token', token);
        document.getElementById('login-error').classList.add('hidden');
        document.getElementById('login-overlay').classList.add('opacity-0', 'pointer-events-none');
        this.toast('Acesso liberado. Ambiente demonstrativo em paper trading.');
        this.loadAlerts(); this.loadEvents(); this.loadJournal(); this.updatePerf();
    },

    async restoreSession() {
        try {
            const headers = this.token ? { 'Authorization': 'Bearer ' + this.token } : {};
            const res = await fetch('/api/auth/session', { headers, credentials: 'same-origin', cache: 'no-store' });
            if (!res.ok) throw new Error('Sessão ausente');
            const data = await res.json(); this.token = data.token; localStorage.setItem('alpha_token', data.token);
            document.getElementById('login-overlay').classList.add('opacity-0', 'pointer-events-none');
        } catch (error) { this.token = null; localStorage.removeItem('alpha_token'); }
    },

    togglePasswordVisibility() {
        const input = document.getElementById('login-pass'); input.type = input.type === 'password' ? 'text' : 'password'; input.focus();
    },

    async logout() {
        localStorage.removeItem('alpha_token'); this.token = null;
        try { await fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin' }); } catch (error) {}
        location.href = '/?logout=1';
    },

    async updateEngineStatus() {
        try {
            const health = await (await fetch('/api/health')).json();
            const status = document.getElementById('engine-status');
            status.innerHTML = `<span class="h-2 w-2 bg-emerald-500 rounded-full animate-pulse"></span> ${health.signalMonitorEnabled ? 'SINAIS ATIVOS' : health.engineStatus} • PAPER`;
            if (health.liveTradingEnabled) status.className = status.className.replace('text-yellow-500', 'text-red-500');
        } catch (error) { console.warn('Health check indisponível:', error.message); }
    },

    async setupTabs() {
        let symbols = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'XRPUSDT'];
        try {
            const response = await fetch('/api/market/leaders?limit=15');
            const result = await response.json();
            if (result.success) symbols = [...new Set([...symbols, ...result.data.filter(item => item.eligibleForMomentumEntry).slice(0, 5).map(item => item.symbol)])];
        } catch (error) { console.warn('Não foi possível carregar líderes:', error.message); }
        const custom = this.getStoredList('alpha_custom_symbols');
        this.symbols = [...new Set([...symbols, ...custom])];
        this.renderTabs();
    },

    getStoredList(key) {
        try { const value = JSON.parse(localStorage.getItem(key) || '[]'); return Array.isArray(value) ? value.filter(item => typeof item === 'string') : []; }
        catch (_) { return []; }
    },

    renderTabs() {
        const container = document.getElementById('symbol-tabs'); const favorites = this.getStoredList('alpha_favorites');
        const symbols = [...this.symbols].sort((a, b) => (favorites.includes(b) ? 1 : 0) - (favorites.includes(a) ? 1 : 0));
        container.innerHTML = '';
        symbols.forEach(s => {
            const btn = document.createElement('button');
            btn.className = 'px-3 py-1 rounded text-[10px] mono transition-all shrink-0 ' + (s === this.activeSymbol ? 'bg-gold text-black font-bold' : 'bg-gray-800 text-gray-400 hover:bg-gray-700');
            btn.dataset.symbol = s; btn.innerText = `${favorites.includes(s) ? '★ ' : ''}${s}`;
            btn.onclick = () => this.selectSymbol(s);
            container.appendChild(btn);
        });
        this.updateFavoriteButton();
    },

    selectSymbol(symbol) {
        this.activeSymbol = symbol; this.renderTabs(); this.loadSymbol(symbol);
    },

    toggleFavorite() {
        const favorites = this.getStoredList('alpha_favorites'); const index = favorites.indexOf(this.activeSymbol);
        if (index >= 0) favorites.splice(index, 1); else favorites.unshift(this.activeSymbol);
        localStorage.setItem('alpha_favorites', JSON.stringify(favorites.slice(0, 30)));
        this.lastExtraScanAt = 0;
        this.renderTabs(); this.toast(index >= 0 ? 'Ativo removido dos favoritos.' : 'Ativo adicionado aos favoritos.');
    },

    updateFavoriteButton() {
        const favorite = this.getStoredList('alpha_favorites').includes(this.activeSymbol); const button = document.getElementById('favorite-btn');
        if (!button) return; button.innerText = favorite ? '★' : '☆'; button.className = `text-xl hover:text-yellow-400 ${favorite ? 'text-yellow-400' : 'text-gray-600'}`;
    },

    async addAsset() {
        const input = document.getElementById('new-symbol'); const symbol = input.value.toUpperCase().replace('/', '').trim();
        if (!/^[A-Z0-9]{2,10}USDT$/.test(symbol)) return this.toast('Use um par USDT válido, como ADAUSDT.', true);
        try {
            const response = await fetch(`/api/ticker/${encodeURIComponent(symbol)}`); const result = await response.json();
            if (!response.ok || !result.success) throw new Error('Par não encontrado na Binance Futures.');
            const custom = this.getStoredList('alpha_custom_symbols'); if (!custom.includes(symbol)) custom.push(symbol);
            localStorage.setItem('alpha_custom_symbols', JSON.stringify(custom.slice(-30)));
            this.lastExtraScanAt = 0;
            if (!this.symbols.includes(symbol)) this.symbols.push(symbol);
            input.value = ''; this.selectSymbol(symbol); this.toast(`${symbol} adicionado à lista.`);
        } catch (error) { this.toast(error.message, true); }
    },

    initChart() {
        const chartContainer = document.getElementById('main-chart');
        if (!window.LightweightCharts) {
            chartContainer.innerHTML = '<div class="h-full flex items-center justify-center text-gray-500 mono text-xs">Biblioteca do gráfico indisponível</div>';
            return;
        }
        this.chart = LightweightCharts.createChart(chartContainer, {
            width: chartContainer.clientWidth,
            height: chartContainer.clientHeight,
            layout: { background: { type: 'solid', color: '#07090d' }, textColor: '#7c8598', fontFamily: 'JetBrains Mono' },
            grid: { vertLines: { color: '#151922' }, horzLines: { color: '#151922' } },
            crosshair: { mode: LightweightCharts.CrosshairMode.Normal, vertLine: { color: '#64748b', width: 1, style: LightweightCharts.LineStyle.Dashed, labelBackgroundColor: '#334155' }, horzLine: { color: '#64748b', width: 1, style: LightweightCharts.LineStyle.Dashed, labelBackgroundColor: '#334155' } },
            rightPriceScale: { borderColor: '#252a35', scaleMargins: { top: 0.12, bottom: 0.2 } },
            timeScale: { borderColor: '#252a35', timeVisible: true, secondsVisible: false, rightOffset: 4, barSpacing: 9, minBarSpacing: 3 },
        });
        this.candleSeries = this.chart.addCandlestickSeries({
            upColor: '#26a69a', downColor: '#ef5350', borderVisible: false, wickUpColor: '#26a69a', wickDownColor: '#ef5350',
        });
        this.chart.subscribeClick(param => this.handleChartClick(param));
        this.chart.subscribeCrosshairMove(param => {
            const candle = param.seriesData?.get(this.candleSeries);
            if (candle) this.updateOhlc(candle);
            else if (this.currentChartCandles.length) this.updateOhlc(this.currentChartCandles.at(-1));
        });
        window.addEventListener('resize', () => {
            this.chart.applyOptions({ width: chartContainer.clientWidth, height: chartContainer.clientHeight });
        });
    },

    bindChartControls() {
        document.querySelectorAll('[data-timeframe]').forEach(button => button.addEventListener('click', () => {
            this.chartTimeframe = button.dataset.timeframe;
            document.querySelectorAll('[data-timeframe]').forEach(item => item.classList.toggle('active', item === button));
            this.renderChart();
        }));
        document.querySelectorAll('[data-tool]').forEach(button => button.addEventListener('click', () => {
            const tool = button.dataset.tool;
            this.chartTools[tool] = !this.chartTools[tool];
            button.classList.toggle('active', this.chartTools[tool]);
            this.renderChart();
        }));
        document.querySelectorAll('[data-draw]').forEach(button => button.addEventListener('click', () => {
            const mode = button.dataset.draw;
            if (mode === 'undo') {
                const drawings = this.getDrawings(); drawings.pop(); localStorage.setItem(this.drawingStorageKey(), JSON.stringify(drawings));
                this.clearManualVisuals(); this.renderManualDrawings(); this.toast('Último desenho removido.'); return;
            }
            if (mode === 'clear') {
                localStorage.removeItem(this.drawingStorageKey());
                this.clearManualVisuals(); this.drawingMode = null; this.drawingPoints = [];
                document.querySelectorAll('[data-draw]').forEach(item => item.classList.remove('active'));
                this.toast('Desenhos deste ativo e timeframe removidos.');
                return;
            }
            this.drawingMode = this.drawingMode === mode ? null : mode; this.drawingPoints = [];
            document.querySelectorAll('[data-draw]').forEach(item => item.classList.toggle('active', item.dataset.draw === this.drawingMode));
            if (this.drawingMode) this.toast(mode === 'horizontal' ? 'Clique uma vez no gráfico.' : 'Clique em dois pontos do gráfico.');
        }));
        document.getElementById('drawing-snap').addEventListener('click', event => {
            this.drawingSnap = !this.drawingSnap; event.currentTarget.classList.toggle('active', this.drawingSnap);
            this.toast(`Ímã de OHLC ${this.drawingSnap ? 'ativado' : 'desativado'}.`);
        });
        document.getElementById('chart-log').addEventListener('click', event => {
            this.chartLogarithmic = !this.chartLogarithmic; event.currentTarget.classList.toggle('active', this.chartLogarithmic);
            this.chart.priceScale('right').applyOptions({ mode: this.chartLogarithmic ? LightweightCharts.PriceScaleMode.Logarithmic : LightweightCharts.PriceScaleMode.Normal });
        });
        document.getElementById('chart-grid').addEventListener('click', event => {
            this.chartGridVisible = !this.chartGridVisible; event.currentTarget.classList.toggle('active', this.chartGridVisible);
            const color = this.chartGridVisible ? '#151922' : 'rgba(0,0,0,0)'; this.chart.applyOptions({ grid: { vertLines: { color }, horzLines: { color } } });
        });
        document.getElementById('chart-reset').addEventListener('click', () => this.resetChartView());
        document.getElementById('chart-focus').addEventListener('click', event => {
            this.chartFocused = !this.chartFocused; document.getElementById('chart-panel').classList.toggle('chart-focus', this.chartFocused); event.currentTarget.classList.toggle('active', this.chartFocused); event.currentTarget.innerText = this.chartFocused ? '✕ Sair' : '⛶ Foco';
            requestAnimationFrame(() => this.chart.applyOptions({ width: document.getElementById('main-chart').clientWidth, height: document.getElementById('main-chart').clientHeight }));
        });
        window.addEventListener('keydown', event => { if (event.key === 'Escape' && this.drawingMode) this.finishDrawing('Ferramenta cancelada.', false); });
    },

    async loadSymbol(symbol, silent = false) {
        document.getElementById('active-symbol').innerText = symbol;
        if (this.analysisController) this.analysisController.abort();
        this.analysisController = new AbortController();
        if (!silent) this.setAnalysisLoading(true);
        try {
            const res = await fetch('/api/analysis/' + symbol, { signal: this.analysisController.signal });
            const data = await res.json();
            if (!res.ok || !data.success) throw new Error(data.error || 'Análise indisponível');
            this.latestAnalysis = data;
            
            // v2.0: Update Decision Tree
            if (this.decisionTree) {
                this.decisionTree.update({
                    monthly: data.monthly,
                    weekly: data.weekly,
                    daily: data.daily,
                    fourHour: data.fourHour,
                    oneHour: data.oneHour,
                    signal: data.signal,
                    readiness: data.signal.readiness
                });
            }

            // Price & Symbol
            document.getElementById('current-price').innerText = data.ticker.lastPrice;
            const alertPrice = document.getElementById('alert-price');
            if (alertPrice) alertPrice.value = data.ticker.lastPrice;
            
            // Signal & Score
            const scoreEl = document.getElementById('signal-score');
            const actionEl = document.getElementById('signal-action');
            const readiness = data.signal.readiness || { score: data.signal.score, label: data.signal.action };
            scoreEl.innerText = Math.round(data.signal.action === 'AGUARDAR' ? readiness.score : data.signal.score) + '%';
            actionEl.innerText = data.signal.action === 'AGUARDAR' ? readiness.label : data.signal.action;
            const visualDirection = data.signal.action === 'AGUARDAR' ? readiness.direction : data.signal.action;
            actionEl.className = 'text-lg font-bold uppercase tracking-widest ' + 
                (visualDirection === 'COMPRA' ? 'text-green-500' : visualDirection === 'VENDA' ? 'text-red-500' : 'text-gray-400');

            // Signal Pipeline State
            const state = data.signal.state || 'UNKNOWN';
            const steps = {
              scenario: ['CONFIRMED', 'WAITING_FOR_TRIGGER', 'WAITING_FOR_CONFIRMATION'].includes(state) || state === 'DATA_ERROR',
              trigger: ['CONFIRMED', 'WAITING_FOR_CONFIRMATION'].includes(state),
              confirmed: state === 'CONFIRMED'
            };
            document.getElementById('step-scenario').className = `flex-1 rounded-full transition-all duration-500 ${steps.scenario ? 'bg-emerald-500 shadow-[0_0_8px_rgba(16,185,129,0.5)]' : 'bg-gray-800'}`;
            document.getElementById('step-trigger').className = `flex-1 rounded-full transition-all duration-500 ${steps.trigger ? 'bg-emerald-500 shadow-[0_0_8px_rgba(16,185,129,0.5)]' : 'bg-gray-800'}`;
            document.getElementById('step-confirmed').className = `flex-1 rounded-full transition-all duration-500 ${steps.confirmed ? 'bg-emerald-500 shadow-[0_0_8px_rgba(16,185,129,0.5)]' : 'bg-gray-800'}`;

            // Risk Intelligence
            const risk = data.riskAssessment;
            const riskPanel = document.getElementById('risk-intel');
            if (risk && risk.ok) {
                riskPanel.classList.remove('hidden');
                document.getElementById('risk-size').innerText = risk.sizing.size.toFixed(4);
                document.getElementById('risk-margin').innerText = `$${risk.margin.requiredMargin.toFixed(2)}`;
                document.getElementById('risk-status').innerText = 'SISTEMA OK';
                document.getElementById('risk-status').className = 'text-[9px] mono font-bold uppercase text-emerald-400';
            } else {
                riskPanel.classList.remove('hidden');
                document.getElementById('risk-size').innerText = '—';
                document.getElementById('risk-margin').innerText = '—';
                document.getElementById('risk-status').innerText = risk?.reason || 'BLOQUEADO';
                document.getElementById('risk-status').className = 'text-[9px] mono font-bold uppercase text-red-400';
            }

            // Audit Evidence
            const evidence = data.signal.evidence;
            const evidencePanel = document.getElementById('audit-evidence');
            if (evidence && data.signal.action !== 'AGUARDAR') {
                evidencePanel.classList.remove('hidden');
                document.getElementById('ev-adx').innerText = evidence.metrics.adx4h.toFixed(1);
                document.getElementById('ev-rsi').innerText = evidence.metrics.rsi4h.toFixed(1);
                document.getElementById('ev-vol').innerText = evidence.metrics.volRatio4h.toFixed(2) + 'x';
                document.getElementById('ev-fund').innerText = (evidence.metrics.funding * 100).toFixed(4) + '%';
                document.getElementById('ev-chg').innerText = evidence.metrics.change24h + '%';
                document.getElementById('ev-setup').innerText = evidence.selectedSetup || '—';
            } else {
                evidencePanel.classList.add('hidden');
            }

            // Order Flow
            document.getElementById('flow-cvd').innerText = data.orderFlow.cvd.netDelta.toFixed(2);
            document.getElementById('flow-poc').innerText = data.orderFlow.vp.poc.toFixed(2);
            document.getElementById('flow-funding').innerText = (data.orderFlow.fundingRate * 100).toFixed(4) + '%';

            // AI Report
            document.getElementById('ai-report').innerText = data.aiReport.technicalAnalysis;
            document.getElementById('ai-provider').innerText = `${String(data.aiReport.provider || 'local').toUpperCase()} • ${data.aiReport.model || 'RULES'}`;
            const influence = data.influence;
            document.getElementById('influence-summary').innerText = influence?.narrative || 'Influência quantitativa indisponível.';
            const trendElement = document.getElementById('influence-trend'); trendElement.innerText = influence?.trend || '—';
            trendElement.className = `text-[10px] mono ${influence?.trend === 'ALTA' ? 'text-emerald-400' : influence?.trend === 'BAIXA' ? 'text-red-400' : 'text-yellow-400'}`;
            document.getElementById('influence-factors').innerHTML = (influence?.drivers || []).map(driver => `<span class="px-2 py-1 rounded border border-gray-800 ${driver.impact === 'POSITIVO' ? 'text-emerald-400' : driver.impact === 'NEGATIVO' ? 'text-red-400' : 'text-gray-500'}" title="${driver.detail}">${driver.factor}</span>`).join('');
            const newsItems = influence?.news?.items || [];
            document.getElementById('influence-news').innerHTML = newsItems.length ? newsItems.slice(0, 3).map(item => `<a href="${this.safeExternalUrl(item.link)}" target="_blank" rel="noopener noreferrer" class="block hover:text-gold truncate">${this.escapeHtml(item.source)} · ${this.escapeHtml(item.title)}</a>`).join('') : '<span>Sem manchetes recentes relacionadas.</span>';

            this.setTimeframe('tf-1m', data.monthly.bias);
            this.setTimeframe('tf-1w', data.weekly.structure);
            this.setTimeframe('tf-1d', data.daily.bias);
            this.setTimeframe('tf-4h', data.signal.setup || 'SEM SETUP');
            this.setTimeframe('tf-1h', data.oneHour.trigger);
            const warning = data.signal.warnings?.[0]; const missing = readiness.missing?.[0];
            document.getElementById('signal-setup').innerText = warning || missing || (data.signal.setup ? `${data.signal.setup} • ${data.signal.conviction}` : 'Monitor ativo; aguardando confluência completa.');

            this.renderChart();
            if (this.token) this.loadAlerts(true);

        } catch (e) {
            if (e.name !== 'AbortError') {
                document.getElementById('ai-report').innerText = `Não foi possível atualizar os dados: ${e.message}. Verifique a conexão e tente novamente.`;
                this.toast('Falha ao carregar a análise.', true);
            }
        } finally {
            if (!silent) this.setAnalysisLoading(false);
        }
    },

    setAnalysisLoading(loading) {
        const report = document.getElementById('ai-report');
        if (loading) report.innerText = 'Consultando Binance e processando 1M → 1W → 1D → 4H → 1H…';
        document.getElementById('current-price').classList.toggle('animate-pulse', loading);
    },

    renderChart() {
        if (!this.candleSeries || !this.latestAnalysis) return;
        const source = this.latestAnalysis.timeframeCandles[this.chartTimeframe] || [];
        const candles = source.map(candle => ({
            time: Math.floor(Number(candle.time) / 1000),
            open: Number(candle.open), high: Number(candle.high), low: Number(candle.low), close: Number(candle.close), volume: Number(candle.volume)
        })).filter(candle => [candle.time, candle.open, candle.high, candle.low, candle.close].every(Number.isFinite));
        this.currentChartCandles = candles;
        this.clearChartTools();
        this.candleSeries.setData(candles.map(({ time, open, high, low, close }) => ({ time, open, high, low, close })));
        if (!candles.length) return;

        if (this.chartTools.ema) {
            this.addLine(this.ema(candles, 9), '#22d3ee', 1, 'EMA 9');
            this.addLine(this.ema(candles, 21), '#c5a059', 2, 'EMA 21');
            this.addLine(this.ema(candles, 50), '#a78bfa', 1, 'EMA 50');
        }
        if (this.chartTools.bollinger) {
            const bands = this.bollinger(candles, 20, 2);
            this.addLine(bands.upper, '#64748b', 1, 'BB superior');
            this.addLine(bands.middle, '#94a3b8', 1, 'BB média');
            this.addLine(bands.lower, '#64748b', 1, 'BB inferior');
        }
        if (this.chartTools.volume) this.addVolume(candles);
        if (this.chartTools.vwap) this.addLine(this.vwap(candles), '#f97316', 2, 'VWAP');
        const pivots = this.findPivots(candles);
        this.candleSeries.setMarkers(this.chartTools.pivots ? pivots.markers : []);
        if (this.chartTools.levels) this.addSupportResistance(candles, pivots);
        if (this.chartTools.fibo) this.addFibonacci(candles);
        if (this.chartTools.poc) this.addPriceLevel(Number(this.latestAnalysis.orderFlow?.vp?.poc), '#38bdf8', 'POC', LightweightCharts.LineStyle.Solid);
        if (this.chartTools.risk) this.addRiskReward();
        if (this.chartTools.channel) this.addTrendChannels(candles, pivots);
        if (this.chartTools.liquidity) this.addLiquidityLevels(pivots);
        if (this.chartTools.blocks) this.addOrderBlocks(candles);
        this.clearManualVisuals();
        this.renderManualDrawings();

        const last = candles.at(-1); const range = this.swingRange(candles);
        this.updateOhlc(last);
        document.getElementById('chart-insights').innerText = `${this.chartTimeframe.toUpperCase()} • Fechamento ${this.formatPrice(last.close)} • Topo ${this.formatPrice(range.high)} • Fundo ${this.formatPrice(range.low)} • Amplitude ${((range.high / range.low - 1) * 100).toFixed(2)}%`;
        this.resetChartView();
    },

    resetChartView() {
        const length = this.currentChartCandles.length;
        if (length) this.chart.timeScale().setVisibleLogicalRange({ from: Math.max(0, length - 65), to: length + 3 });
        this.chart.priceScale('right').applyOptions({ autoScale: true });
    },

    updateOhlc(candle) {
        const open = Number(candle.open); const close = Number(candle.close); const change = open ? (close / open - 1) * 100 : 0; const color = change >= 0 ? 'text-emerald-400' : 'text-red-400';
        document.getElementById('ohlc-o').innerText = this.formatPrice(open); document.getElementById('ohlc-h').innerText = this.formatPrice(Number(candle.high)); document.getElementById('ohlc-l').innerText = this.formatPrice(Number(candle.low)); document.getElementById('ohlc-c').innerText = this.formatPrice(close);
        const changeElement = document.getElementById('ohlc-change'); changeElement.innerText = `${change >= 0 ? '+' : ''}${change.toFixed(2)}%`; changeElement.className = color;
    },

    drawingStorageKey() {
        return `alpha_drawings:${this.activeSymbol}:${this.chartTimeframe}`;
    },

    getDrawings() {
        try {
            const drawings = JSON.parse(localStorage.getItem(this.drawingStorageKey()) || '[]');
            return Array.isArray(drawings) ? drawings.slice(-30) : [];
        } catch (_) { return []; }
    },

    saveDrawing(drawing) {
        const drawings = this.getDrawings(); drawings.push(drawing);
        localStorage.setItem(this.drawingStorageKey(), JSON.stringify(drawings.slice(-30)));
    },

    handleChartClick(param) {
        if (!this.drawingMode || !param.point || param.time === undefined) return;
        let price = this.candleSeries.coordinateToPrice(param.point.y); const time = Number(param.time);
        if (!Number.isFinite(price) || !Number.isFinite(time)) return;
        if (this.drawingSnap) {
            const candle = this.currentChartCandles.find(item => item.time === time);
            if (candle) { const nearest = [candle.open, candle.high, candle.low, candle.close].sort((a, b) => Math.abs(a - price) - Math.abs(b - price))[0]; if (Math.abs(nearest - price) / price <= 0.005) price = nearest; }
        }
        const point = { time, price };
        if (this.drawingMode === 'horizontal') {
            this.saveDrawing({ type: 'horizontal', price }); this.finishDrawing('Nível horizontal salvo.'); return;
        }
        this.drawingPoints.push(point);
        if (this.drawingPoints.length < 2) { this.toast('Primeiro ponto marcado. Selecione o segundo.'); return; }
        const [first, second] = this.drawingPoints.sort((a, b) => a.time - b.time);
        if (this.drawingMode === 'trend') {
            this.saveDrawing({ type: 'trend', first, second }); this.finishDrawing('Linha de tendência salva.');
        } else if (this.drawingMode === 'ruler') {
            const change = (second.price / first.price - 1) * 100; const hours = Math.abs(second.time - first.time) / 3600;
            this.finishDrawing(`Medição: ${change >= 0 ? '+' : ''}${change.toFixed(2)}% em ${hours.toFixed(1)}h.`, false);
        }
    },

    finishDrawing(message, redraw = true) {
        this.drawingMode = null; this.drawingPoints = [];
        document.querySelectorAll('[data-draw]').forEach(item => item.classList.remove('active'));
        if (redraw) { this.clearManualVisuals(); this.renderManualDrawings(); }
        this.toast(message);
    },

    clearManualVisuals() {
        this.manualSeries.forEach(series => this.chart.removeSeries(series)); this.manualSeries = [];
        this.manualPriceLines.forEach(line => this.candleSeries.removePriceLine(line)); this.manualPriceLines = [];
    },

    renderManualDrawings() {
        this.getDrawings().forEach(drawing => {
            if (drawing.type === 'horizontal' && Number.isFinite(Number(drawing.price))) {
                const line = this.candleSeries.createPriceLine({ price: Number(drawing.price), color: '#60a5fa', lineWidth: 2, lineStyle: LightweightCharts.LineStyle.Dashed, axisLabelVisible: true, title: 'Nível manual' });
                this.manualPriceLines.push(line);
            }
            if (drawing.type === 'trend' && Number.isFinite(Number(drawing.first?.time)) && Number.isFinite(Number(drawing.second?.time))) {
                const series = this.chart.addLineSeries({ color: '#60a5fa', lineWidth: 2, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: true });
                series.setData([{ time: Number(drawing.first.time), value: Number(drawing.first.price) }, { time: Number(drawing.second.time), value: Number(drawing.second.price) }]);
                this.manualSeries.push(series);
            }
        });
    },

    clearChartTools() {
        this.overlaySeries.forEach(series => this.chart.removeSeries(series));
        this.overlaySeries = [];
        this.chartPriceLines.forEach(line => this.candleSeries.removePriceLine(line));
        this.chartPriceLines = [];
        this.candleSeries.setMarkers([]);
    },

    addLine(data, color, lineWidth, title) {
        if (!data.length) return;
        const series = this.chart.addLineSeries({ color, lineWidth, title, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false });
        series.setData(data);
        this.overlaySeries.push(series);
    },

    ema(candles, period) {
        if (candles.length < period) return [];
        const multiplier = 2 / (period + 1); let value = candles.slice(0, period).reduce((sum, candle) => sum + candle.close, 0) / period;
        const points = [{ time: candles[period - 1].time, value }];
        for (let index = period; index < candles.length; index += 1) {
            value = candles[index].close * multiplier + value * (1 - multiplier);
            points.push({ time: candles[index].time, value });
        }
        return points;
    },

    bollinger(candles, period, deviations) {
        const result = { upper: [], middle: [], lower: [] };
        for (let index = period - 1; index < candles.length; index += 1) {
            const values = candles.slice(index - period + 1, index + 1).map(candle => candle.close);
            const mean = values.reduce((sum, value) => sum + value, 0) / period;
            const std = Math.sqrt(values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / period);
            result.middle.push({ time: candles[index].time, value: mean });
            result.upper.push({ time: candles[index].time, value: mean + std * deviations });
            result.lower.push({ time: candles[index].time, value: mean - std * deviations });
        }
        return result;
    },

    vwap(candles) {
        let cumulativeVolume = 0; let cumulativeValue = 0;
        return candles.map(candle => {
            const typicalPrice = (candle.high + candle.low + candle.close) / 3;
            cumulativeVolume += candle.volume;
            cumulativeValue += typicalPrice * candle.volume;
            return { time: candle.time, value: cumulativeVolume ? cumulativeValue / cumulativeVolume : typicalPrice };
        });
    },

    addVolume(candles) {
        const series = this.chart.addHistogramSeries({ priceFormat: { type: 'volume' }, priceScaleId: '', lastValueVisible: false, priceLineVisible: false });
        series.priceScale().applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });
        series.setData(candles.map(candle => ({ time: candle.time, value: candle.volume, color: candle.close >= candle.open ? 'rgba(38,166,154,.32)' : 'rgba(239,83,80,.32)' })));
        this.overlaySeries.push(series);
    },

    findPivots(candles, window = 2) {
        const highs = []; const lows = [];
        for (let index = window; index < candles.length - window; index += 1) {
            const neighbors = candles.slice(index - window, index + window + 1);
            if (candles[index].high === Math.max(...neighbors.map(item => item.high))) highs.push(candles[index]);
            if (candles[index].low === Math.min(...neighbors.map(item => item.low))) lows.push(candles[index]);
        }
        const markers = [
            ...highs.slice(-6).map(candle => ({ time: candle.time, position: 'aboveBar', color: '#ef4444', shape: 'arrowDown', text: 'Topo' })),
            ...lows.slice(-6).map(candle => ({ time: candle.time, position: 'belowBar', color: '#10b981', shape: 'arrowUp', text: 'Fundo' }))
        ].sort((a, b) => a.time - b.time);
        return { highs, lows, markers };
    },

    addSupportResistance(candles, pivots) {
        const support = pivots.lows.at(-1)?.low ?? Math.min(...candles.slice(-20).map(candle => candle.low));
        const resistance = pivots.highs.at(-1)?.high ?? Math.max(...candles.slice(-20).map(candle => candle.high));
        this.addPriceLevel(support, '#10b981', 'Suporte');
        this.addPriceLevel(resistance, '#ef4444', 'Resistência');
    },

    addPriceLevel(price, color, title, style = LightweightCharts.LineStyle.Dashed) {
        if (!Number.isFinite(price)) return;
        const line = this.candleSeries.createPriceLine({ price, color, lineWidth: 1, lineStyle: style, axisLabelVisible: true, title });
        this.chartPriceLines.push(line);
    },

    swingRange(candles) {
        const window = candles.slice(-Math.min(60, candles.length));
        const high = Math.max(...window.map(candle => candle.high));
        const low = Math.min(...window.map(candle => candle.low));
        return { high, low, highIndex: window.findIndex(candle => candle.high === high), lowIndex: window.findIndex(candle => candle.low === low) };
    },

    addFibonacci(candles) {
        const range = this.swingRange(candles); const size = range.high - range.low;
        if (!(size > 0)) return;
        const upwardImpulse = range.lowIndex < range.highIndex;
        [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1].forEach((ratio, index) => {
            const price = upwardImpulse ? range.high - size * ratio : range.low + size * ratio;
            const color = ratio === 0.5 ? '#f59e0b' : ratio === 0.618 ? '#ec4899' : '#475569';
            this.addPriceLevel(price, color, `Fib ${(ratio * 100).toFixed(1)}%`, index === 0 || ratio === 1 ? LightweightCharts.LineStyle.Solid : LightweightCharts.LineStyle.Dotted);
        });
    },

    addRiskReward() {
        const trade = this.latestAnalysis.tradeParams;
        if (!trade || trade.status === 'AGUARDAR') return;
        this.addPriceLevel(Number(trade.entryPrice), '#e5e7eb', 'Entrada', LightweightCharts.LineStyle.Solid);
        this.addPriceLevel(Number(trade.stopLoss), '#ef4444', 'Stop', LightweightCharts.LineStyle.Solid);
        this.addPriceLevel(Number(trade.takeProfit1), '#22c55e', 'TP1 · 2R');
        this.addPriceLevel(Number(trade.takeProfit2), '#10b981', 'TP2 · 3R');
        this.addPriceLevel(Number(trade.takeProfit3), '#059669', 'TP3 · 4R');
    },

    addTrendChannels(candles, pivots) {
        const draw = (points, field, color, title) => {
            if (points.length < 2) return;
            const first = points.at(-2); const second = points.at(-1);
            const firstIndex = candles.findIndex(candle => candle.time === first.time); const secondIndex = candles.findIndex(candle => candle.time === second.time);
            if (firstIndex < 0 || secondIndex <= firstIndex) return;
            const slope = (second[field] - first[field]) / (secondIndex - firstIndex); const data = [];
            for (let index = firstIndex; index < candles.length; index += 1) data.push({ time: candles[index].time, value: first[field] + slope * (index - firstIndex) });
            this.addLine(data, color, 2, title);
        };
        draw(pivots.highs, 'high', '#fb7185', 'Canal superior');
        draw(pivots.lows, 'low', '#34d399', 'Canal inferior');
    },

    addLiquidityLevels(pivots) {
        const clustered = (points, field) => {
            for (let index = points.length - 1; index > 0; index -= 1) {
                for (let previous = index - 1; previous >= 0; previous -= 1) {
                    const average = (points[index][field] + points[previous][field]) / 2;
                    if (Math.abs(points[index][field] - points[previous][field]) / average <= 0.0035) return average;
                }
            }
            return null;
        };
        this.addPriceLevel(clustered(pivots.highs, 'high'), '#f43f5e', 'Liquidez buy-side', LightweightCharts.LineStyle.Dotted);
        this.addPriceLevel(clustered(pivots.lows, 'low'), '#14b8a6', 'Liquidez sell-side', LightweightCharts.LineStyle.Dotted);
    },

    addOrderBlocks(candles) {
        let bullish = null; let bearish = null;
        for (let index = candles.length - 2; index >= Math.max(14, candles.length - 35) && (!bullish || !bearish); index -= 1) {
            const ranges = candles.slice(index - 14, index).map(candle => candle.high - candle.low);
            const averageRange = ranges.reduce((sum, value) => sum + value, 0) / ranges.length;
            const candle = candles[index]; const displacement = candles[index + 1];
            if (!bullish && candle.close < candle.open && displacement.close > displacement.open && displacement.close - displacement.open >= averageRange * 1.2) bullish = candle;
            if (!bearish && candle.close > candle.open && displacement.close < displacement.open && displacement.open - displacement.close >= averageRange * 1.2) bearish = candle;
        }
        if (bullish) {
            this.addPriceLevel(bullish.high, '#22c55e', 'OB alta · teto', LightweightCharts.LineStyle.Dotted);
            this.addPriceLevel(bullish.low, '#15803d', 'OB alta · base', LightweightCharts.LineStyle.Dotted);
        }
        if (bearish) {
            this.addPriceLevel(bearish.high, '#b91c1c', 'OB baixa · teto', LightweightCharts.LineStyle.Dotted);
            this.addPriceLevel(bearish.low, '#ef4444', 'OB baixa · base', LightweightCharts.LineStyle.Dotted);
        }
    },

    formatPrice(value) {
        if (!Number.isFinite(value)) return '—';
        return value >= 1000 ? value.toLocaleString('pt-BR', { maximumFractionDigits: 2 }) : value.toLocaleString('pt-BR', { maximumFractionDigits: 6 });
    },

    escapeHtml(value) {
        return String(value || '').replace(/[&<>'"]/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[character]));
    },

    safeExternalUrl(value) {
        try { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) ? this.escapeHtml(url.href) : '#'; }
        catch (_) { return '#'; }
    },

    setTimeframe(id, value) {
        const element = document.getElementById(id);
        const text = String(value || 'NEUTRO');
        element.innerText = text.replace('BULLISH', 'ALTA').replace('BEARISH', 'BAIXA').replace('COMPRA', 'LONG').replace('VENDA', 'SHORT');
        element.className = /BULL|ALTA|COMPRA|LONG/.test(text) ? 'text-emerald-400' : /BEAR|BAIXA|VENDA|SHORT/.test(text) ? 'text-red-400' : 'text-gray-400';
    },

    toast(message, error = false) {
        const element = document.getElementById('app-toast');
        element.innerText = message;
        element.classList.toggle('text-red-400', error);
        element.classList.toggle('text-emerald-400', !error);
        element.classList.remove('opacity-0');
        clearTimeout(this.toastTimer);
        this.toastTimer = setTimeout(() => element.classList.add('opacity-0'), 3500);
    },

    async runBacktest() {
        const button = document.getElementById('backtest-btn');
        const output = document.getElementById('backtest-result');
        button.disabled = true; button.innerText = 'Processando…';
        output.innerText = 'Validando a sequência completa sem olhar o futuro…';
        try {
            const response = await fetch(`/api/backtest/${encodeURIComponent(this.activeSymbol)}?candles=500&risk=1&fee=0.04&slippage=0.02`);
            const result = await response.json();
            if (!response.ok || !result.success) throw new Error(result.error || 'Backtest indisponível');
            const metrics = result.data.metrics;
            output.innerHTML = `<span class="text-white">${metrics.totalTrades} trades</span> · WR <span class="text-white">${metrics.winRate}%</span> · PF <span class="text-white">${metrics.profitFactor}</span> · retorno <span class="${metrics.totalReturnPercent >= 0 ? 'text-emerald-400' : 'text-red-400'}">${metrics.totalReturnPercent}%</span> · DD ${metrics.maxDrawdownPercent}%`;
        } catch (error) {
            output.innerText = `Falha: ${error.message}`;
        } finally {
            button.disabled = false; button.innerText = 'Executar';
        }
    },

    async loadAutomation(silent = false) {
        try {
            const response = await fetch('/api/automation/status'); const result = await response.json();
            if (!response.ok || !result.success) throw new Error(result.error || 'Scanner indisponível');
            const snapshot = result.data; const status = document.getElementById('automation-status');
            status.innerText = snapshot.status === 'RUNNING' ? 'TEMPO REAL' : snapshot.status;
            status.className = `text-[9px] mono ${snapshot.status === 'RUNNING' ? 'text-emerald-400' : 'text-yellow-500'}`;
            document.getElementById('automation-meta').innerText = `${snapshot.scanCount || 0} varreduras · ${snapshot.confirmedSignals || 0} sinais confirmados · atualização ${snapshot.updatedAt ? new Date(snapshot.updatedAt).toLocaleTimeString('pt-BR') : 'pendente'}`;
            let opportunities = snapshot.opportunities || [];
            const extraSymbols = [...new Set([...this.getStoredList('alpha_custom_symbols'), ...this.getStoredList('alpha_favorites')])].filter(symbol => !opportunities.some(item => item.symbol === symbol)).slice(0, 15);
            if (extraSymbols.length && Date.now() - this.lastExtraScanAt >= 60_000) {
                const extraResponse = await fetch(`/api/scan?symbols=${encodeURIComponent(extraSymbols.join(','))}`); const extraResult = await extraResponse.json();
                if (extraResult.success) { this.extraOpportunities = extraResult.data; this.lastExtraScanAt = Date.now(); }
            }
            opportunities = [...opportunities, ...this.extraOpportunities].filter((item, index, array) => array.findIndex(candidate => candidate.symbol === item.symbol) === index).sort((a, b) => Number(b.action !== 'AGUARDAR' ? b.score : b.readiness?.score || 0) - Number(a.action !== 'AGUARDAR' ? a.score : a.readiness?.score || 0));
            const current = opportunities.find(item => item.symbol === this.activeSymbol);
            if (current && Number.isFinite(Number(current.price))) document.getElementById('current-price').innerText = current.price;
            const ranked = opportunities.filter(item => item.action !== 'AGUARDAR').concat(opportunities.filter(item => item.action === 'AGUARDAR')).slice(0, 4);
            const list = document.getElementById('opportunity-list');
            if (!ranked.length) list.innerText = snapshot.status === 'STARTING' ? 'Analisando o mercado…' : 'Nenhum ativo disponível.';
            else list.innerHTML = ranked.map(item => {
                const display = item.action === 'AGUARDAR' ? item.readiness?.label || 'AGUARDAR' : item.action; const displayScore = item.action === 'AGUARDAR' ? item.readiness?.score || 0 : item.score;
                const color = display.includes('COMPRA') ? 'text-emerald-400' : display.includes('VENDA') ? 'text-red-400' : 'text-gray-500';
                return `<button onclick="app.selectOpportunity('${item.symbol}')" class="w-full grid grid-cols-[1fr_auto_auto] gap-3 items-center bg-black border border-gray-800 hover:border-gray-600 rounded p-2 text-left"><span class="text-white">${item.symbol}</span><span class="${color}">${display}</span><span>${Math.round(displayScore)}%</span></button>`;
            }).join('');
        } catch (error) { if (!silent) document.getElementById('opportunity-list').innerText = error.message; }
    },

    async runSignalScan() {
        if (!this.token) return this.toast('Entre na demonstração para iniciar a varredura.', true);
        const button = document.getElementById('scan-now-btn'); button.disabled = true; button.innerText = 'Analisando…';
        try {
            const res = await fetch('/api/automation/run', { method: 'POST', headers: { 'Authorization': 'Bearer ' + this.token }, credentials: 'same-origin' }); const data = await res.json();
            if (!res.ok || !data.success) throw new Error(data.error || 'Varredura indisponível.'); this.toast(data.message); await this.loadAutomation();
        } catch (error) { this.toast(error.message, true); }
        finally { button.disabled = false; button.innerText = 'Rodar agora'; }
    },

    async loadLivePrice() {
        try {
            const response = await fetch(`/api/ticker/${encodeURIComponent(this.activeSymbol)}`); const result = await response.json();
            const price = Number(result.data?.lastPrice); if (!response.ok || !Number.isFinite(price)) return;
            const element = document.getElementById('current-price');
            element.innerText = this.formatPrice(price);
            element.classList.remove('text-green-400', 'text-red-400');
            if (Number.isFinite(this.lastLivePrice) && price !== this.lastLivePrice) {
                element.classList.add(price > this.lastLivePrice ? 'text-green-400' : 'text-red-400');
                setTimeout(() => element.classList.remove('text-green-400', 'text-red-400'), 900);
            }
            this.lastLivePrice = price;
        } catch (_) {}
    },

    selectOpportunity(symbol) {
        if (!this.symbols.includes(symbol)) this.symbols.push(symbol);
        this.selectSymbol(symbol);
    },

    async createAlert() {
        if (!this.token) return this.toast('Faça login para criar alertas.', true);
        const condition = document.getElementById('alert-condition').value;
        const price = Number(document.getElementById('alert-price').value);
        if (!(price > 0)) return this.toast('Informe um preço válido.', true);
        try {
            const response = await fetch('/api/alerts', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + this.token }, body: JSON.stringify({ symbol: this.activeSymbol, condition, price }) });
            const result = await response.json();
            if (!response.ok || !result.success) throw new Error(result.error || 'Falha ao criar alerta');
            this.toast(`Alerta criado para ${this.activeSymbol}.`);
            this.loadAlerts();
        } catch (error) { this.toast(error.message, true); }
    },

    async loadAlerts(silent = false) {
        if (!this.token) return;
        try {
            const response = await fetch(`/api/alerts?symbol=${encodeURIComponent(this.activeSymbol)}`, { headers: { 'Authorization': 'Bearer ' + this.token } });
            if (response.status === 401) { this.token = null; localStorage.removeItem('alpha_token'); return; }
            const result = await response.json();
            if (!response.ok || !result.success) throw new Error(result.error || 'Falha ao carregar alertas');
            const active = result.data.filter(alert => alert.status === 'ACTIVE');
            const triggered = result.data.filter(alert => alert.status === 'TRIGGERED');
            if (this.alertsInitialized) triggered.forEach(alert => {
                if (!this.knownTriggeredAlerts.has(alert.id)) {
                    this.toast(`Alerta disparado: ${alert.symbol} em ${this.formatPrice(Number(alert.marketPrice))}`);
                    this.notifyUser(`Alerta ${alert.symbol}`, `Preço ${this.formatPrice(Number(alert.marketPrice))} atingiu o nível configurado.`);
                }
            });
            triggered.forEach(alert => this.knownTriggeredAlerts.add(alert.id)); this.alertsInitialized = true;
            document.getElementById('alert-count').innerText = `${active.length} ATIVOS`;
            const list = document.getElementById('alert-list');
            if (!result.data.length) list.innerText = 'Nenhum alerta configurado para este ativo.';
            else list.innerHTML = result.data.slice(0, 5).map(alert => `<div class="flex justify-between items-center bg-black border border-gray-800 rounded p-2"><span class="${alert.status === 'TRIGGERED' ? 'text-emerald-400' : 'text-gray-300'}">${alert.condition === 'ABOVE' ? '↑' : '↓'} ${this.formatPrice(Number(alert.price))}${alert.status === 'TRIGGERED' ? ' · DISPARADO' : ''}</span><button onclick="app.deleteAlert('${alert.id}')" class="text-red-400">×</button></div>`).join('');
        } catch (error) { if (!silent) this.toast(error.message, true); }
    },

    async deleteAlert(id) {
        try {
            const response = await fetch('/api/alerts/' + encodeURIComponent(id), { method: 'DELETE', headers: { 'Authorization': 'Bearer ' + this.token } });
            const result = await response.json();
            if (!response.ok || !result.success) throw new Error(result.error || 'Falha ao remover alerta');
            this.loadAlerts();
        } catch (error) { this.toast(error.message, true); }
    },

    async enableNotifications() {
        if (!('Notification' in window)) return this.toast('Notificações não são suportadas neste navegador.', true);
        const permission = await Notification.requestPermission();
        document.getElementById('notification-btn').innerText = permission === 'granted' ? 'Notificações ativas' : 'Notificações bloqueadas';
        this.toast(permission === 'granted' ? 'Notificações do navegador ativadas.' : 'Permissão de notificação não concedida.', permission !== 'granted');
    },

    notifyUser(title, body) {
        if ('Notification' in window && Notification.permission === 'granted') new Notification(title, { body, tag: title });
    },

    async loadEvents(silent = false) {
        if (!this.token) return;
        try {
            const headers = { 'Authorization': 'Bearer ' + this.token };
            const [signalsResponse, alertsResponse] = await Promise.all([fetch('/api/signals?limit=15', { headers }), fetch('/api/alerts', { headers })]);
            const [signals, alerts] = await Promise.all([signalsResponse.json(), alertsResponse.json()]);
            if (!signalsResponse.ok || !alertsResponse.ok) throw new Error('Central de eventos indisponível.');
            const signalItems = signals.data || [];
            if (this.eventsInitialized) signalItems.forEach(item => { if (!this.knownSignalIds.has(item.id)) this.notifyUser(`Novo sinal ${item.symbol}`, `${item.action} · ${Math.round(item.score)}% · ${item.setup || 'setup confirmado'}`); });
            signalItems.forEach(item => this.knownSignalIds.add(item.id)); this.eventsInitialized = true;
            const events = [
                ...signalItems.map(item => ({ type: 'SIGNAL', date: item.timestamp, title: `${item.symbol} · ${item.action}`, detail: `${Math.round(item.score)}%${item.setup ? ` · ${item.setup}` : ''}`, color: item.action === 'COMPRA' ? 'text-emerald-400' : 'text-red-400' })),
                ...(alerts.data || []).filter(item => item.status === 'TRIGGERED').map(item => ({ type: 'ALERT', date: item.triggered_at, title: `${item.symbol} · ALERTA`, detail: `${item.condition === 'ABOVE' ? '↑' : '↓'} ${this.formatPrice(Number(item.price))}`, color: 'text-yellow-400' }))
            ].sort((a, b) => Date.parse(b.date || 0) - Date.parse(a.date || 0)).slice(0, 6);
            const list = document.getElementById('event-list');
            list.innerHTML = events.length ? events.map(event => `<div class="bg-black border border-gray-800 rounded p-2"><div class="flex justify-between"><span class="${event.color}">${this.escapeHtml(event.title)}</span><span class="text-gray-600">${event.date ? new Date(event.date).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : ''}</span></div><div class="text-gray-500 mt-1">${this.escapeHtml(event.detail)}</div></div>`).join('') : 'Nenhuma transição de sinal ou alerta disparado.';
        } catch (error) { if (!silent) document.getElementById('event-list').innerText = error.message; }
    },

    async openPaperTrade() {
        if (!this.token) return alert('Please login first');
        const risk = document.getElementById('risk-val').value;
        const walletBalance = document.getElementById('wallet-val').value;

        if (!this.latestAnalysis || !['COMPRA', 'VENDA'].includes(this.latestAnalysis.signal.action)) return alert('O motor não possui sinal operável para este ativo neste momento.');

        try {
            const res = await fetch('/api/paper/open', {
                method: 'POST',
                headers: { 
                    'Content-Type': 'application/json',
                    'Authorization': 'Bearer ' + this.token
                },
                body: JSON.stringify({ symbol: this.activeSymbol, riskPercent: risk, walletBalance })
            });
            const data = await res.json();
            alert(data.success ? 'Operação paper aberta com sucesso.' : 'Erro: ' + data.error);
            if (data.success) this.updatePerf();
        } catch (e) {
            alert('Falha ao abrir a operação paper.');
        }
    },

    async closePaperTrade(id) {
        try {
            const res = await fetch('/api/paper/close/' + encodeURIComponent(id), { method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + this.token }, body: JSON.stringify({ reason: 'MANUAL' }) });
            const data = await res.json();
            alert(data.success ? 'Operação paper encerrada.' : 'Erro: ' + data.error);
            this.updatePerf(); this.loadJournal();
        } catch (e) { alert('Falha ao encerrar a operação paper.'); }
    },

    async loadJournal(silent = false) {
        try {
            const res = await fetch('/api/journal?limit=20', { headers: { 'Authorization': 'Bearer ' + this.token } });
            if (res.status === 401 || res.status === 403) { if (!silent) this.toast('Sessão expirada. Faça login novamente.', true); return; }
            const payload = await res.json(); if (!payload.success) throw new Error(payload.error);
            const stats = payload.analytics; const pf = stats.profitFactor === null ? '∞' : Number(stats.profitFactor || 0).toFixed(2);
            document.getElementById('journal-summary').innerHTML = `<div class="bg-black border border-gray-800 rounded p-2"><span class="block text-[9px] text-gray-600 mono">EXPECTATIVA</span><b class="text-xs ${stats.expectancy >= 0 ? 'text-emerald-400' : 'text-red-400'} mono">$${Number(stats.expectancy).toFixed(2)}</b></div><div class="bg-black border border-gray-800 rounded p-2"><span class="block text-[9px] text-gray-600 mono">PROFIT FACTOR</span><b class="text-xs text-white mono">${pf}</b></div><div class="bg-black border border-gray-800 rounded p-2"><span class="block text-[9px] text-gray-600 mono">REVISADOS</span><b class="text-xs text-white mono">${stats.reviewed}/${stats.total}</b></div>`;
            const list = document.getElementById('journal-list');
            list.innerHTML = payload.data.length ? payload.data.slice(0, 6).map(trade => { const pnl = Number(trade.pnl || 0); const when = new Date(trade.exit_time || trade.entry_time).toLocaleDateString('pt-BR'); return `<div class="flex items-center justify-between gap-2 border-b border-gray-800 pb-2"><div class="min-w-0"><b class="text-white">${this.escapeHtml(trade.symbol)}</b> <span class="${trade.status === 'OPEN' ? 'text-yellow-400' : pnl >= 0 ? 'text-emerald-400' : 'text-red-400'}">${trade.status === 'OPEN' ? 'ABERTA' : `$${pnl.toFixed(2)}`}</span><div class="text-[9px] text-gray-600 truncate">${this.escapeHtml(trade.setup || 'Sem setup')} · ${when}${trade.note ? ` · ${this.escapeHtml(trade.note)}` : ''}</div></div><button onclick="app.reviewTrade('${trade.id}', '${trade.reviewStatus === 'REVIEWED' ? 'REVIEWED' : 'IN_REVIEW'}')" class="chart-tool shrink-0">${trade.reviewStatus === 'REVIEWED' ? '✓ Revisado' : 'Revisar'}</button></div>`; }).join('') : 'O diário será preenchido pelas operações paper.';
        } catch (error) { if (!silent) this.toast('Não foi possível carregar o diário.', true); }
    },

    async reviewTrade(id, currentStatus) {
        const note = window.prompt('Registre a tese, execução e aprendizado desta operação:');
        if (note === null) return;
        const tagText = window.prompt('Tags separadas por vírgula (ex.: pullback, fibo, 1h):', '');
        if (tagText === null) return;
        try {
            const res = await fetch('/api/journal/' + encodeURIComponent(id), { method: 'PATCH', headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + this.token }, body: JSON.stringify({ note, tags: tagText.split(','), reviewStatus: currentStatus === 'REVIEWED' ? 'IN_REVIEW' : 'REVIEWED' }) });
            const data = await res.json(); if (!data.success) throw new Error(data.error); this.toast('Revisão registrada no diário.'); this.loadJournal();
        } catch (error) { this.toast(error.message || 'Falha ao salvar revisão.', true); }
    },

    async exportJournal() {
        try {
            const res = await fetch('/api/journal/export.csv', { headers: { 'Authorization': 'Bearer ' + this.token } });
            if (!res.ok) throw new Error('Não foi possível exportar.');
            const blob = await res.blob(); const url = URL.createObjectURL(blob); const link = document.createElement('a'); link.href = url; link.download = `crypto-trade-journal-${new Date().toISOString().slice(0, 10)}.csv`; link.click(); URL.revokeObjectURL(url);
        } catch (error) { this.toast(error.message, true); }
    },

    async updatePerf() {
        try {
            const res = await fetch('/api/performance');
            const data = await res.json();
            if (data.success) {
                const stats = data.data;
                document.getElementById('stat-winrate').innerText = `WR ${Math.round(stats.win_rate || 0)}%`;
                document.getElementById('stat-pnl').innerText = `Médio $${Number(stats.avg_pnl || 0).toFixed(2)}`;
                document.getElementById('stat-open').innerText = `${stats.open_trades || 0} posições`;
            }
            if (this.token) {
                const paperRes = await fetch('/api/paper/portfolio', { headers: { 'Authorization': 'Bearer ' + this.token } });
                const paperData = await paperRes.json();
                const box = document.getElementById('paper-position');
                if (paperData.success) {
                    const portfolio = paperData.data; const summary = portfolio.summary;
                    document.getElementById('portfolio-pnl').innerText = `$${Number(summary.unrealizedPnlUSD).toFixed(2)}`;
                    document.getElementById('portfolio-pnl').className = `text-lg font-bold ${summary.unrealizedPnlUSD >= 0 ? 'text-emerald-400' : 'text-red-400'}`;
                    document.getElementById('portfolio-exposure').innerText = `$${Number(summary.totalExposureUSD).toFixed(0)}`;
                    document.getElementById('portfolio-risk').innerText = `${Number(summary.openRiskPercent).toFixed(2)}%`;
                    document.getElementById('portfolio-margin').innerText = `$${Number(summary.usedMarginUSD).toFixed(2)}`;
                    const status = document.getElementById('portfolio-status'); status.innerText = portfolio.status === 'SAFE' ? 'CONTROLADO' : portfolio.status === 'LIMIT' ? 'NO LIMITE' : 'VAZIA'; status.className = `text-[9px] mono ${portfolio.status === 'LIMIT' ? 'text-red-400' : portfolio.status === 'SAFE' ? 'text-emerald-400' : 'text-gray-500'}`;
                    const riskUse = summary.maxRiskPercent ? Math.min(100, summary.openRiskPercent / summary.maxRiskPercent * 100) : 0; const bar = document.getElementById('portfolio-risk-bar'); bar.style.width = `${riskUse}%`; bar.className = `h-full transition-all ${riskUse >= 80 ? 'bg-red-500' : riskUse >= 50 ? 'bg-yellow-500' : 'bg-emerald-500'}`;
                    if (portfolio.positions.length) box.innerHTML = portfolio.positions.map(trade => `<div class="flex justify-between items-center py-1 border-b border-gray-800"><span>${this.escapeHtml(trade.symbol)} ${trade.side} · <b class="${trade.unrealizedPnl >= 0 ? 'text-emerald-400' : 'text-red-400'}">$${Number(trade.unrealizedPnl).toFixed(2)} (${Number(trade.rMultiple).toFixed(2)}R)</b></span><button class="text-red-400" onclick="app.closePaperTrade('${trade.id}')">Fechar</button></div>`).join('');
                    else box.innerText = 'Nenhuma posição paper aberta';
                }
            }
        } catch (e) {}
    }
    switchTab(tab) {
        const tabs = ['journal', 'alerts', 'events', 'edge'];
        tabs.forEach(t => {
            const el = document.getElementById(	ab-);
            if (el) el.classList.toggle('hidden', t !== tab);
        });
        document.querySelectorAll('[onclick^="app.switchTab"]').forEach(btn => {
            const isMatch = btn.getAttribute('onclick').includes('');
            btn.classList.toggle('bg-gray-800', isMatch);
            btn.classList.toggle('text-white', isMatch);
            btn.classList.toggle('text-gray-500', !isMatch);
        });
        if (tab === 'edge') this.loadEdge();
    },

    async loadEdge() {
        if (!this.token) return;
        try {
            const response = await fetch('/api/analysis/heatmap', { headers: { 'Authorization': 'Bearer ' + this.token } });
            const result = await response.json();
            if (!response.ok || !result.success) throw new Error(result.error || 'Falha ao carregar heatmap');
            const list = document.getElementById('edge-list');
            if (!result.data.length) list.innerText = 'Sem dados suficientes para calcular edge.';
            else list.innerHTML = result.data.map(item => {
                const color = item.edge === 'STRONG' ? 'text-emerald-400' : item.edge === 'POSITIVE' ? 'text-emerald-500' : item.edge === 'NEGATIVE' ? 'text-red-400' : 'text-gray-500';
                return <div class="flex justify-between items-center bg-black border border-gray-800 rounded p-2">
                    <span class="text-white font-bold"></span>
                    <div class="flex gap-3">
                        <span class="text-gray-500 mono">n=\</span>
                        <span class="\ font-bold mono">\% WR</span>
                    </div>
                </div>;
            }).join('');
        } catch (error) { this.toast(error.message, true); }
    },};

window.onload = () => app.init();
document.getElementById('login-form').addEventListener('submit', event => { event.preventDefault(); app.login(); });
document.getElementById('new-symbol').addEventListener('keydown', event => {
    if (event.key === 'Enter') app.addAsset();
});

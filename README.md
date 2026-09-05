# Crypto Signal Engine v2.0

> Motor de análise cripto quantitativo sequencial (1M + 1W + 1D + 4H + 1H) com paper trading, microestrutura e otimização automática.

## O que é v2.0

O Crypto Signal Engine é um sistema completo de análise técnica quantitativa para criptomoedas em futuros perpetual na Binance. A versão 2.0 adiciona:

- **Persistência SQLite** — Substitui JSON file-based por SQLite com WAL mode, queries indexadas e atomicidade
- **Microestrutura de mercado** — Funding spread entre exchanges, estimativa de clusters de liquidação, detecção de spoofing, CVD divergence em timeframes curtos
- **Otimização automática** — Grid search + random search nos hiperparâmetros da estratégia
- **Decision Tree visual** — Widget interativo mostrando o pipeline de decisão em tempo real
- **Alertas de prontidão** — Notificações quando um ativo atinge estágios específicos do pipeline
- **Health check avançado** — Monitoramento de sistema, serviços externos, logs estruturados e webhooks
- **Walk-forward expandido** — 15.000+ candles com validação out-of-sample real

## Arquitetura

```
Frontend (SPA) ←→ Express Server ←→ 28 módulos de serviço
                       ↓
              SQLite (WAL mode)
```

### Stack

| Camada | Tecnologia |
|--------|-----------|
| Runtime | Node.js 20 |
| Servidor | Express 5 + WebSocket |
| Frontend | Vanilla JS + Tailwind + Lightweight Charts |
| Persistência | SQLite (better-sqlite3) |
| APIs | Binance Futures, Telegram, RSS, Ollama/OpenAI |
| Testes | Node.js built-in test runner |

## Novos Módulos v2.0

### microstructureService.js
- `getFundingSpread(symbol)` — Funding rates de Binance, Bybit e OKX
- `estimateLiquidationClusters()` — Estimativa de zonas de liquidação
- `detectOrderBookAnomalies()` — Detecção de spoofing/layering
- `detectCVDDivergence()` — Divergência CVD-preço em 5m/15m
- `getCrossAssetContext()` — Correlação BTC, fluxo institucional, regime de alavancagem

### strategyOptimizer.js
- `runGridSearch()` — Busca em grade系统ática
- `runRandomSearch()` — Busca aleatória (mais eficiente)
- `optimizeStrategy()` — Pipeline completo: grid + random + validação + walk-forward
- `evaluateFitness()` — Função de aptidão com 5 componentes ponderados

### healthService.js
- `getHealthReport()` — Relatório completo de saúde do sistema
- `checkServices()` — Verifica Binance, AI Service, Database
- `log()` — Logging estruturado com ring buffer
- `startMonitoring()` — Monitoramento periódico com alertas webhook

### readinessAlertService.js
- `updateReadiness()` — Atualiza estado de prontidão por símbolo
- `addAlertRule()` — Regras configuráveis (score mínimo, status, direção, cooldown)
- `formatAlert()` — Formatação para console, Telegram e webhook

### decision-tree.js + decision-tree.css
- Widget visual do pipeline de decisão
- 5 nós conectados com status colorido
- Animações de glow para estágios ativos
- Tema Obsidian Dark com glass morphism

## Instalação

```bash
# 1. Instalar dependências
npm install

# 2. Configurar variáveis de ambiente
cp .env.example .env
# Editar .env com suas credenciais

# 3. Iniciar
npm start

# 4. Acessar
# http://localhost:3000
```

## Scripts

```bash
npm start          # Iniciar servidor
npm test           # Rodar testes
npm run validate   # Walk-forward validation
npm run calibrate  # Calibração de perfil
npm run optimize   # Otimização de estratégia
```

## API v2.0 (Novos Endpoints)

| Método | Endpoint | Descrição |
|--------|----------|-----------|
| GET | /api/health | Relatório de saúde completo |
| GET | /api/health/services | Status dos serviços externos |
| GET | /api/health/logs | Logs estruturados recentes |
| GET | /api/microstructure/:symbol | Análise de microestrutura |
| POST | /api/optimizer/run | Otimização de estratégia |
| GET | /api/readiness/states | Estados de prontidão |
| GET | /api/readiness/rules | Regras de alerta |
| POST | /api/readiness/rules | Criar regra de alerta |
| DELETE | /api/readiness/rules/:id | Remover regra |

## Variáveis de Ambiente (v2.0)

```env
# Novas em v2.0
MICROSTRUCTURE_ENABLED=true
FUNDING_SPREAD_THRESHOLD_BPS=10
OPTIMIZATION_MAX_ITERATIONS=200
OPTIMIZATION_WALK_FORWARD_FOLDS=5
ALERT_WEBHOOK_URL=
HEALTH_CHECK_INTERVAL_MS=30000
MEMORY_ALERT_THRESHOLD_MB=500
DATA_FILE=./trading_brain.db
```

## Segurança

- JWT auth com rate limiting (10 tentativas / 5 min)
- LIVE_TRADING_ENABLED=false por padrão
- Circuit breaker automático
- Timing-safe password comparison

**ATENÇÃO:** Altere ADMIN_PASSWORD e JWT_SECRET antes de qualquer exposição pública.

## Licença

MIT

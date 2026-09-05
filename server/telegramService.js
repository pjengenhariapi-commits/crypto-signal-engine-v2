const axios = require('axios');
const fs = require('fs');
const path = require('path');

const CONFIG_FILE = path.join(__dirname, 'telegramConfig.json');

// Configuração padrão
const defaultConfig = {
  botToken: '',
  chatId: '',
  autoAlertsEnabled: false,
  minScore: 70,
  alertIntervalMinutes: 15,
  lastAlertTimestamps: {}
};

/**
 * Carrega a configuração do Telegram
 */
function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      const raw = fs.readFileSync(CONFIG_FILE, 'utf8');
      return { ...defaultConfig, ...JSON.parse(raw) };
    }
  } catch (err) {
    console.error('Erro ao ler telegramConfig.json:', err.message);
  }
  return { ...defaultConfig };
}

/**
 * Salva a configuração do Telegram
 */
function saveConfig(updated) {
  try {
    const current = loadConfig();
    const merged = { ...current, ...updated };
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(merged, null, 2), 'utf8');
    return merged;
  } catch (err) {
    console.error('Erro ao salvar telegramConfig.json:', err.message);
    throw err;
  }
}

/**
 * Retorna a configuração pública (com token parcialmente oculto para segurança)
 */
function getPublicConfig() {
  const cfg = loadConfig();
  let maskedToken = '';
  if (cfg.botToken && cfg.botToken.length > 8) {
    maskedToken = cfg.botToken.slice(0, 5) + '...' + cfg.botToken.slice(-4);
  }

  return {
    isConfigured: Boolean(cfg.botToken && cfg.chatId),
    botTokenMasked: maskedToken,
    hasToken: Boolean(cfg.botToken),
    chatId: cfg.chatId,
    autoAlertsEnabled: cfg.autoAlertsEnabled,
    minScore: cfg.minScore,
    alertIntervalMinutes: cfg.alertIntervalMinutes
  };
}

/**
 * Envia uma mensagem para o Telegram
 * Possui fallback automático caso o Telegram rejeite formatação Markdown
 */
async function sendTelegramMessage(text, customToken = null, customChatId = null) {
  const cfg = loadConfig();
  const token = customToken || cfg.botToken;
  const chatId = customChatId || cfg.chatId;

  if (!token || !chatId) {
    throw new Error('Telegram não configurado. Forneça o Bot Token e o Chat ID.');
  }

  const url = `https://api.telegram.org/bot${token}/sendMessage`;

  try {
    // Tenta primeiro com parse_mode Markdown
    const res = await axios.post(url, {
      chat_id: chatId,
      text: text,
      parse_mode: 'Markdown'
    }, { timeout: 8000 });
    return { success: true, messageId: res.data?.result?.message_id };
  } catch (err) {
    // Fallback para texto puro caso o Markdown contenha caracteres não escapados
    try {
      const res = await axios.post(url, {
        chat_id: chatId,
        text: text.replace(/[*_`]/g, '') // remove markdown marks
      }, { timeout: 8000 });
      return { success: true, messageId: res.data?.result?.message_id, fallback: true };
    } catch (fallbackErr) {
      const errMsg = fallbackErr.response?.data?.description || fallbackErr.message;
      throw new Error(`Falha no envio do Telegram: ${errMsg}`);
    }
  }
}

/**
 * Testa a conexão com o Telegram enviando uma mensagem de verificação
 */
async function testConnection(botToken, chatId) {
  const testMessage = `🤖 *Paulo Moreira Analise Crypto* 🤖
✅ *Conexão com o Telegram Estabelecida com Sucesso!*

Seu bot está configurado e pronto para despachar:
• Sinais de Compra/Venda com Stop Loss e Alvos
• Confluências Multi-Timeframe (1M • 1W • 4H)
• Dimensionamento de Risco e Alavancagem Sugerida

Hora do teste: ${new Date().toLocaleString('pt-BR')}`;

  return await sendTelegramMessage(testMessage, botToken, chatId);
}

/**
 * Despachador de alerta inteligente com filtro anti-spam (não repete mesmo ativo no mesmo candle)
 */
async function dispatchTradeAlertIfQualified(symbol, action, score, alertText) {
  const cfg = loadConfig();
  if (!cfg.autoAlertsEnabled || !cfg.botToken || !cfg.chatId) return false;
  if (action === 'AGUARDAR' || score < cfg.minScore) return false;

  const now = Date.now();
  const FOUR_HOURS_MS = 4 * 60 * 60 * 1000;
  const lastAlertTime = cfg.lastAlertTimestamps[symbol] || 0;

  // Evita spam: se já alertou esse ativo há menos de 4 horas, ignora
  if (now - lastAlertTime < FOUR_HOURS_MS) {
    return false;
  }

  try {
    await sendTelegramMessage(alertText);
    cfg.lastAlertTimestamps[symbol] = now;
    saveConfig({ lastAlertTimestamps: cfg.lastAlertTimestamps });
    console.log(`[Telegram Alert] Alerta automático de ${action} enviado para ${symbol}`);
    return true;
  } catch (err) {
    console.error(`[Telegram Alert Error] Falha ao enviar alerta para ${symbol}:`, err.message);
    return false;
  }
}

/**
 * Detecta automaticamente o Chat ID inspecionando as mensagens recebidas pelo bot
 */
async function detectChatIdFromUpdates() {
  const cfg = loadConfig();
  if (!cfg.botToken) throw new Error('Token do bot não configurado.');

  const res = await axios.get(`https://api.telegram.org/bot${cfg.botToken}/getUpdates`, { timeout: 8000 });
  const updates = res.data?.result || [];

  if (updates.length === 0) {
    return {
      found: false,
      message: 'Nenhuma mensagem recente encontrada. Abra o Telegram, pesquise por @Crypto1996_Bot e envie /start.'
    };
  }

  for (let i = updates.length - 1; i >= 0; i--) {
    const u = updates[i];
    const chat = u.message?.chat || u.channel_post?.chat || u.my_chat_member?.chat;
    if (chat && chat.id) {
      const detectedChatId = String(chat.id);
      saveConfig({ chatId: detectedChatId });
      return {
        found: true,
        chatId: detectedChatId,
        firstName: chat.first_name || chat.title || 'Usuário',
        username: chat.username || '',
        type: chat.type
      };
    }
  }

  return { found: false, message: 'Nenhum Chat ID identificado.' };
}

module.exports = {
  loadConfig,
  saveConfig,
  getPublicConfig,
  sendTelegramMessage,
  testConnection,
  dispatchTradeAlertIfQualified,
  detectChatIdFromUpdates
};

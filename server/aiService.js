const AI_URL = process.env.AI_SERVICE_URL || 'http://localhost:11434/v1';
const cache = new Map();

function getAIStatus() {
  const configured = Boolean(process.env.AI_MODEL);
  const isLocal = AI_URL.includes('localhost') || AI_URL.includes('127.0.0.1');
  return { 
    configured, 
    provider: configured ? (isLocal ? 'OPENCODE/LOCAL' : 'CLOUD') : 'local-rules', 
    model: configured ? process.env.AI_MODEL : 'deterministic-rules' 
  };
}

function responseText(payload) {
  if (typeof payload.output_text === 'string') return payload.output_text.trim();
  if (payload.choices && payload.choices[0]?.message?.content) return payload.choices[0].message.content.trim();
  return (payload.output || []).flatMap(item => item.content || []).filter(item => item.type === 'output_text').map(item => item.text).join('\n').trim();
}

async function enhanceAnalysis(context, fallbackText) {
  const status = getAIStatus();
  if (!status.configured) return { ...status, text: fallbackText };
  
  const cacheKey = JSON.stringify({ symbol: context.symbol, action: context.signal?.action, score: context.signal?.score, setup: context.signal?.setup });
  const cached = cache.get(cacheKey);
  if (cached && Date.now() - cached.createdAt < 5 * 60 * 1000) return { ...cached.value, cached: true };

  const controller = new AbortController(); 
  const timer = setTimeout(() => controller.abort(), 15000);
  
  try {
    const response = await fetch(`${AI_URL}/chat/completions`, {
      method: 'POST', 
      signal: controller.signal,
      headers: { 
        'Content-Type': 'application/json', 
        Authorization: process.env.AI_SERVICE_KEY ? `Bearer ${process.env.AI_SERVICE_KEY}` : '' 
      },
      body: JSON.stringify({
        model: process.env.AI_MODEL,
        messages: [
          { 
            role: 'system', 
            content: 'Você é um analista quantitativo de risco sênior. Explique somente os dados fornecidos em português claro. Não altere o sinal calculado, não prometa retorno, não invente notícias e destaque conflitos entre timeframes. Responda em até quatro parágrafos curtos e objetivos.' 
          },
          { role: 'user', content: JSON.stringify(context) }
        ],
        max_tokens: 450,
        temperature: 0.3
      })
    });

    if (!response.ok) throw new Error(`AI Service HTTP ${response.status}`);
    const json = await response.json();
    const text = responseText(json);
    
    if (!text) throw new Error('Resposta de IA vazia');
    
    const value = { ...status, text }; 
    cache.set(cacheKey, { createdAt: Date.now(), value });
    if (cache.size > 100) cache.delete(cache.keys().next().value);
    
    return value;
  } catch (error) {
    return { configured: true, provider: 'local-fallback', model: status.model, text: fallbackText, error: error.message };
  } finally { clearTimeout(timer); }
}

module.exports = { getAIStatus, enhanceAnalysis, responseText };

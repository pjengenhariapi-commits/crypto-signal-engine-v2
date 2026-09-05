const finite = value => Number.isFinite(Number(value));

function analyzeInfluence({ symbol, ticker, btcTicker, leaders = [], cvd = {}, funding = {}, news = {}, monthly = {}, weekly = {}, daily = {}, fourHour = {}, oneHour = {} }) {
  const change24h = Number(ticker.priceChangePercent) || 0; const btcChange24h = Number(btcTicker.priceChangePercent) || 0;
  const relativeStrength = change24h - btcChange24h;
  const buyVolume = Number(cvd.buyVolume) || 0; const sellVolume = Number(cvd.sellVolume) || 0; const totalAggression = buyVolume + sellVolume;
  const cvdImbalancePercent = totalAggression ? (buyVolume - sellVolume) / totalAggression * 100 : 0;
  const fundingRatePercent = (Number(funding.fundingRate) || 0) * 100;
  const liquidSample = leaders.filter(item => finite(item.change24h)); const positiveShare = liquidSample.length ? liquidSample.filter(item => Number(item.change24h) > 0).length / liquidSample.length * 100 : 50;
  const volumeRatio = Number(fourHour.volumeRatio) || 0;
  const directions = [monthly.bias, weekly.structure, daily.bias, fourHour.structure, oneHour.trigger];
  const trendScore = directions.reduce((score, value) => score + (/BULL|ALTA|COMPRA/.test(value || '') ? 1 : /BEAR|BAIXA|VENDA/.test(value || '') ? -1 : 0), 0);
  const trend = trendScore >= 3 ? 'ALTA' : trendScore <= -3 ? 'BAIXA' : 'MISTA/CONSOLIDAÇÃO';
  const drivers = [
    { factor: 'Força relativa vs. BTC', impact: relativeStrength > 1 ? 'POSITIVO' : relativeStrength < -1 ? 'NEGATIVO' : 'NEUTRO', value: relativeStrength, detail: `${relativeStrength >= 0 ? 'Supera' : 'Fica atrás de'} o BTC em ${Math.abs(relativeStrength).toFixed(2)} p.p. nas últimas 24h.` },
    { factor: 'Agressão CVD', impact: cvdImbalancePercent > 5 ? 'POSITIVO' : cvdImbalancePercent < -5 ? 'NEGATIVO' : 'NEUTRO', value: cvdImbalancePercent, detail: `${cvdImbalancePercent >= 0 ? 'Compradores' : 'Vendedores'} agressivos dominam o fluxo em ${Math.abs(cvdImbalancePercent).toFixed(1)}%.` },
    { factor: 'Volume 4H', impact: volumeRatio >= 1.2 ? (change24h >= 0 ? 'POSITIVO' : 'NEGATIVO') : 'NEUTRO', value: volumeRatio, detail: volumeRatio >= 1.2 ? `Volume em ${volumeRatio.toFixed(2)}x a média confirma participação no ${change24h >= 0 ? 'avanço' : 'recuo'}.` : `Volume em ${volumeRatio.toFixed(2)}x a média ainda não confirma o movimento.` },
    { factor: 'Funding', impact: fundingRatePercent > 0.05 ? 'NEGATIVO' : fundingRatePercent < -0.05 ? 'POSITIVO' : 'NEUTRO', value: fundingRatePercent, detail: `Funding em ${fundingRatePercent.toFixed(4)}%; extremos podem indicar posicionamento congestionado.` },
    { factor: 'Amostra líquida', impact: positiveShare >= 65 ? 'POSITIVO' : positiveShare <= 35 ? 'NEGATIVO' : 'NEUTRO', value: positiveShare, detail: `${positiveShare.toFixed(0)}% da amostra líquida monitorada está positiva em 24h.` }
  ];
  if (news.items?.length) drivers.push({ factor: 'Noticiário 72h', impact: news.sentiment === 'POSITIVO' ? 'POSITIVO' : news.sentiment === 'NEGATIVO' ? 'NEGATIVO' : 'NEUTRO', value: news.assetSpecific, detail: `${news.items.length} manchetes relevantes, ${news.assetSpecific} específicas do ativo; tom lexical ${news.sentiment}.` });
  const dominant = drivers.filter(item => item.impact !== 'NEUTRO').slice(0, 3);
  const directionText = change24h > 0.5 ? `avança ${change24h.toFixed(2)}%` : change24h < -0.5 ? `recua ${Math.abs(change24h).toFixed(2)}%` : `oscila ${change24h.toFixed(2)}%`;
  const causes = dominant.length ? dominant.map(item => item.detail).join(' ') : 'Os fatores de fluxo e força relativa estão equilibrados, sem um vetor dominante.';
  const newsText = news.items?.length ? ` No noticiário das últimas 72 horas, foram encontradas ${news.items.length} manchetes relacionadas (${news.assetSpecific} específicas do ativo), com leitura lexical ${news.sentiment}.` : ' Não foram encontradas manchetes recentes verificáveis para complementar a leitura.';
  const narrative = `${symbol} ${directionText} em 24h. A leitura quantitativa aponta tendência ${trend}: ${causes}${newsText} Notícias são contexto coincidente e não comprovam, sozinhas, a causa do movimento.`;
  return { trend, trendScore, change24h, btcChange24h, relativeStrength, cvdImbalancePercent, fundingRatePercent, positiveShare, drivers, narrative, news, causality: news.items?.length ? 'QUANTITATIVE_WITH_NEWS_CONTEXT' : 'QUANTITATIVE_INFERENCE' };
}

module.exports = { analyzeInfluence };

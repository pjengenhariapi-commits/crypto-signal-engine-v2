const axios = require('axios');
const crypto = require('crypto');

async function createBinanceOrder(apiKey, apiSecret, params) {
  const { symbol, side, type, quantity, price, stopPrice } = params;
  const timestamp = Date.now();
  let queryString = 'symbol=' + symbol + '&side=' + side + '&type=' + type + '&quantity=' + quantity;
  if (price) queryString += '&price=' + price;
  if (stopPrice) queryString += '&stopPrice=' + stopPrice;
  queryString += '&timestamp=' + timestamp;

  const signature = crypto.createHmac('sha256', apiSecret).update(queryString).digest('hex');
  const url = 'https://fapi.binance.com/fapi/v1/order?' + queryString + '&signature=' + signature;

  try {
    const res = await axios.post(url, {}, {
      headers: { 'X-MBX-APIKEY': apiKey }
    });
    return { success: true, data: res.data };
  } catch (err) {
    return { success: false, error: err.response?.data?.msg || err.message };
  }
}

module.exports = { createBinanceOrder };

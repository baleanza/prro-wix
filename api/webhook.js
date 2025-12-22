import { createClient, ApiKeyStrategy } from '@wix/sdk';
import { orders } from '@wix/ecom';
import axios from 'axios';

// 1. Настройка клиента Wix
const wixClient = createClient({
  modules: { orders },
  auth: ApiKeyStrategy({
    apiKey: process.env.WIX_API_KEY, // Admin API Key
    siteId: process.env.WIX_SITE_ID,
    accountId: process.env.WIX_ACCOUNT_ID
  })
});

// 2. Настройка клиента Checkbox
const CHECKBOX_API = process.env.CHECKBOX_API_URL || 'https://api.checkbox.in.ua/api/v1';

export default async function handler(req, res) {
  // Разрешаем только POST запросы
  if (req.method !== 'POST') return res.status(405).send('Method Not Allowed');

  const { orderId } = req.body;

  if (!orderId) {
    console.error('Ошибка: Не передан orderId');
    return res.status(400).json({ error: 'Missing orderId in request body' });
  }

  console.log(`🚀 Начинаем фискализацию заказа: ${orderId}`);

  try {
    // --- ШАГ 1: Получаем данные заказа из Wix ---
    const wixResponse = await wixClient.orders.getOrder(orderId);
    const order = wixResponse.order;

    if (!order) throw new Error('Заказ не найден в Wix');
    console.log(`✅ Данные заказа получены. Сумма: ${order.priceSummary.total.amount} ${order.currency}`);

    // --- ШАГ 2: Логинимся в Checkbox (Смена кассира) ---
    // Для простоты мы логинимся при каждом запросе. 
    // В идеале токен можно кешировать, но для serverless так надежнее.
    const authResponse = await axios.post(`${CHECKBOX_API}/cashier/signin`, 
      { pin: process.env.CHECKBOX_CASHIER_PIN },
      { headers: { 'X-License-Key': process.env.CHECKBOX_LICENSE_KEY } }
    );
    
    const token = authResponse.data.access_token;
    console.log('✅ Авторизация в Checkbox успешна');

    // --- ШАГ 3: Формируем чек ---
    // Checkbox требует:
    // - Цена в копейках (умножаем на 100)
    // - Количество в тысячных (умножаем на 1000), если это штучный товар
    
    const goods = order.lineItems.map(item => {
      const price = parseFloat(item.price.amount);
      const quantity = item.quantity;

      return {
        good: {
          code: item.catalogReference?.catalogItemId || item.productName.original.substr(0, 10), // SKU или ID
          name: item.productName.original,
          price: Math.round(price * 100), // Цена в копейках (integer)
        },
        quantity: Math.round(quantity * 1000) // Количество * 1000 (integer)
      };
    });

    const totalAmount = parseFloat(order.priceSummary.total.amount);
    
    // Формируем тело чека
    const receiptPayload = {
      goods: goods,
      payments: [
        {
          type: "CASHLESS", // Безнал (оплата на сайте)
          value: Math.round(totalAmount * 100), // Общая сумма в копейках
          label: "Оплата на сайті (Portmone/Tranzzo)"
        }
      ],
      delivery: {
        email: order.buyerInfo.email
      }
    };

    // --- ШАГ 4: Отправляем чек (create -> sell) ---
    const receiptResponse = await axios.post(`${CHECKBOX_API}/receipts/sell`, 
      receiptPayload,
      { headers: { 'Authorization': `Bearer ${token}` } }
    );

    const receiptId = receiptResponse.data.id;
    console.log(`🎉 Чек успешно создан! ID: ${receiptId}`);

    // (Опционально) Можно сохранить ID чека обратно в Wix в Custom Fields, если нужно

    return res.status(200).json({ 
      success: true, 
      receiptId: receiptId,
      message: 'Fiscal receipt created successfully' 
    });

  } catch (error) {
    // Детальный вывод ошибки для логов Vercel
    console.error('❌ ОШИБКА:', error.message);
    if (error.response) {
        console.error('Детали ответа API:', JSON.stringify(error.response.data, null, 2));
    }
    
    return res.status(500).json({ 
      error: error.message,
      details: error.response?.data 
    });
  }
}

import { createClient, ApiKeyStrategy } from '@wix/sdk';
import { orders } from '@wix/ecom';

// 1. Настройка клиента Wix
const wixClient = createClient({
  modules: { orders },
  auth: ApiKeyStrategy({
    apiKey: process.env.WIX_API_KEY, 
    siteId: process.env.WIX_SITE_ID
  })
});

// 2. Настройка клиента Checkbox
const CHECKBOX_API = process.env.CHECKBOX_API_URL || 'https://api.checkbox.in.ua/api/v1';

export default async function handler(req, res) {
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
    const authResponse = await fetch(`${CHECKBOX_API}/cashier/signin`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-License-Key': process.env.CHECKBOX_LICENSE_KEY
      },
      body: JSON.stringify({ pin: process.env.CHECKBOX_CASHIER_PIN })
    });

    if (!authResponse.ok) {
      const errText = await authResponse.text();
      throw new Error(`Ошибка авторизации Checkbox: ${authResponse.status} ${errText}`);
    }

    const authData = await authResponse.json();
    const token = authData.access_token;
    console.log('✅ Авторизация в Checkbox успешна');

    // --- ШАГ 3: Формируем чек ---
    const goods = order.lineItems.map(item => {
      const price = parseFloat(item.price.amount);
      const quantity = item.quantity;

      return {
        good: {
          code: item.catalogReference?.catalogItemId || item.productName.original.substr(0, 10),
          name: item.productName.original,
          price: Math.round(price * 100), // Цена в копейках
        },
        quantity: Math.round(quantity * 1000) // Количество в тысячных
      };
    });

    const totalAmount = parseFloat(order.priceSummary.total.amount);
    
    const receiptPayload = {
      goods: goods,
      payments: [
        {
          type: "CASHLESS",
          value: Math.round(totalAmount * 100),
          label: "Оплата на сайті"
        }
      ],
      delivery: {
        email: order.buyerInfo.email
      }
    };

    // --- ШАГ 4: Отправляем чек (create -> sell) ---
    const receiptResponse = await fetch(`${CHECKBOX_API}/receipts/sell`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(receiptPayload)
    });

    if (!receiptResponse.ok) {
      const errText = await receiptResponse.text();
      throw new Error(`Ошибка создания чека: ${receiptResponse.status} ${errText}`);
    }

    const receiptData = await receiptResponse.json();
    const receiptId = receiptData.id;
    console.log(`🎉 Чек успешно создан! ID: ${receiptId}`);

    return res.status(200).json({ 
      success: true, 
      receiptId: receiptId,
      message: 'Fiscal receipt created successfully' 
    });

  } catch (error) {
    console.error('❌ ОШИБКА:', error.message);
    return res.status(500).json({ 
      error: error.message 
    });
  }
}

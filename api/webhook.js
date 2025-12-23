const CHECKBOX_API = process.env.CHECKBOX_API_URL || 'https://api.checkbox.in.ua/api/v1';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).send('Method Not Allowed');

  // Теперь мы ожидаем объект order сразу
  const { order } = req.body;

  if (!order) {
    console.error('Ошибка: Не передан объект order');
    return res.status(400).json({ error: 'Missing order data in request body' });
  }

  // Данные пришли от wix-stores-backend, структура немного проще
  const totalAmount = order.totals.total; 
  console.log(`🚀 Фискализация заказа ${order.number}. Сумма: ${totalAmount}`);

  try {
    // --- ШАГ 1: Логинимся в Checkbox ---
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
    
    // --- ШАГ 2: Формируем чек ---
    // ВАЖНО: wix-stores-backend отдает item.price как число, а не объект
    const goods = order.lineItems.map(item => {
      return {
        good: {
          code: item.sku || item.productId.substr(0, 10), // SKU или часть ID
          name: item.name,
          price: Math.round(item.price * 100), // Цена в копейках
        },
        quantity: Math.round(item.quantity * 1000) // Кол-во в тысячных
      };
    });

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

    // --- ШАГ 3: Отправляем чек ---
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
    console.log(`🎉 Чек успешно создан! ID: ${receiptData.id}`);

    return res.status(200).json({ 
      success: true, 
      receiptId: receiptData.id 
    });

  } catch (error) {
    console.error('❌ ОШИБКА:', error.message);
    return res.status(500).json({ error: error.message });
  }
}

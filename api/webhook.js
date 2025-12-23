const CHECKBOX_API = process.env.CHECKBOX_API_URL || 'https://api.checkbox.in.ua/api/v1';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).send('Method Not Allowed');

  const { order } = req.body;

  if (!order) {
    console.error('❌ Ошибка: Не передан объект order');
    return res.status(400).json({ error: 'Missing order data in request body' });
  }

  // Отримуємо налаштування (ліцензія + пін)
  const pin = process.env.CHECKBOX_CASHIER_PIN;
  const license = process.env.CHECKBOX_LICENSE_KEY;

  if (!pin || !license) {
    console.error("❌ Не налаштовані змінні середовища CHECKBOX у Vercel!");
    return res.status(500).json({ error: "Checkbox Env Vars Missing" });
  }

  const totalAmount = order.totals.total; 
  console.log(`🚀 Фіскалізація замовлення ${order.number}. Сума: ${totalAmount}`);

  try {
    // --- ШАГ 1: Логинимся в Checkbox ---
    // ВИПРАВЛЕНО: Правильний ендпоінт для входу по PIN-коду
    const authUrl = `${CHECKBOX_API}/cashier/signinPinCode`;
    
    const authResponse = await fetch(authUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-License-Key': license 
      },
      body: JSON.stringify({ pin_code: pin })
    });

    if (!authResponse.ok) {
      const errText = await authResponse.text();
      console.error(`❌ Auth Fail: ${authResponse.status}`, errText);
      throw new Error(`Помилка авторизації Checkbox: ${authResponse.status} ${errText}`);
    }

    const authData = await authResponse.json();
    const token = authData.access_token;
    console.log('✅ Авторизація успішна (Token received)');

    // --- ШАГ 2: Формируем чек ---
    const goods = order.lineItems.map(item => {
      return {
        good: {
          code: item.sku || item.productId.substr(0, 10), 
          name: item.name,
          price: Math.round(item.price * 100), // ціна в копійках
        },
        quantity: Math.round(item.quantity * 1000) // кількість в тисячних
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
      throw new Error(`Помилка створення чека: ${receiptResponse.status} ${errText}`);
    }

    const receiptData = await receiptResponse.json();
    console.log(`🎉 Чек створено! ID: ${receiptData.id}`);

    return res.status(200).json({ 
      success: true, 
      receiptId: receiptData.id 
    });

  } catch (error) {
    console.error('❌ CRITICAL ERROR:', error.message);
    return res.status(500).json({ error: error.message });
  }
}

const CHECKBOX_API = process.env.CHECKBOX_API_URL || 'https://api.checkbox.in.ua/api/v1';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).send('Method Not Allowed');

  const { order } = req.body;
  if (!order) return res.status(400).json({ error: 'Missing order data' });

  const pin = process.env.CHECKBOX_CASHIER_PIN;
  const license = process.env.CHECKBOX_LICENSE_KEY;

  if (!pin || !license) {
    console.error("❌ Env Vars Missing");
    return res.status(500).json({ error: "Checkbox Env Vars Missing" });
  }

  const totalAmount = order.totals.total;
  console.log(`🚀 Обробка замовлення ${order.number}. Сума: ${totalAmount}`);

  try {
    // 1. Авторизація (вхід касира)
    const authResponse = await fetch(`${CHECKBOX_API}/cashier/signinPinCode`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-License-Key': license },
      body: JSON.stringify({ pin_code: pin })
    });

    if (!authResponse.ok) {
      throw new Error(`Auth Error: ${authResponse.status} ${await authResponse.text()}`);
    }

    const { access_token: token } = await authResponse.json();
    console.log('✅ Авторизація успішна');

    // Підготовка даних чека
    const receiptPayload = {
      goods: order.lineItems.map(item => ({
        good: {
          code: item.sku || item.productId.substr(0, 10),
          name: item.name,
          price: Math.round(item.price * 100),
        },
        quantity: Math.round(item.quantity * 1000)
      })),
      payments: [{ type: "CASHLESS", value: Math.round(totalAmount * 100), label: "Оплата на сайті" }],
      delivery: { email: order.buyerInfo.email }
    };

    // 2. Спроба створити чек
    let createResponse = await createReceipt(token, license, receiptPayload);

    // 3. Якщо помилка "Зміна закрита" -> Відкриваємо зміну і пробуємо знову
    if (createResponse.status === 400) {
      const errorData = await createResponse.clone().json().catch(() => ({}));
      
      if (errorData.code === 'shift.not_opened') {
        console.log('⚠️ Зміна закрита. Відкриваємо нову зміну...');
        
        // ИСПРАВЛЕНИЕ: Добавлен заголовок X-License-Key
        const openShiftResponse = await fetch(`${CHECKBOX_API}/shifts`, {
          method: 'POST',
          headers: { 
              'Authorization': `Bearer ${token}`,
              'X-License-Key': license 
          }
        });

        if (!openShiftResponse.ok) {
           throw new Error(`Не вдалося відкрити зміну: ${await openShiftResponse.text()}`);
        }

        console.log('✅ Зміна відкрита! Повторюємо створення чека...');
        // Повторна спроба
        createResponse = await createReceipt(token, license, receiptPayload);
      }
    }

    // Перевірка фінального результату
    if (!createResponse.ok) {
      throw new Error(`Помилка продажу: ${createResponse.status} ${await createResponse.text()}`);
    }

    const receiptData = await createResponse.json();
    console.log(`🎉 Чек створено! ID: ${receiptData.id}`);

    return res.status(200).json({ success: true, receiptId: receiptData.id });

  } catch (error) {
    console.error('❌ CRITICAL ERROR:', error.message);
    return res.status(500).json({ error: error.message });
  }
}

// Допоміжна функція (теперь принимает и license)
async function createReceipt(token, license, payload) {
  return fetch(`${CHECKBOX_API}/receipts/sell`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'X-License-Key': license, // Добавлено для надежности
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    });
}

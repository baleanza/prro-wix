const CHECKBOX_API = process.env.CHECKBOX_API_URL || 'https://api.checkbox.in.ua/api/v1';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).send('Method Not Allowed');

  const { order } = req.body;
  if (!order) return res.status(400).json({ error: 'Відсутні дані замовлення' });

  const pin = process.env.CHECKBOX_CASHIER_PIN;
  const license = process.env.CHECKBOX_LICENSE_KEY;

  if (!pin || !license) {
    console.error("❌ ПОМИЛКА: Не налаштовані змінні середовища");
    return res.status(500).json({ error: "Checkbox Env Vars Missing" });
  }

  const totalAmount = order.totals.total;
  console.log(`🚀 [Vercel] Обробка замовлення #${order.number}. Сума: ${totalAmount}`);

  try {
    // 1. Авторизація
    const authResponse = await fetch(`${CHECKBOX_API}/cashier/signinPinCode`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-License-Key': license },
      body: JSON.stringify({ pin_code: pin })
    });

    if (!authResponse.ok) {
      throw new Error(`Помилка авторизації: ${authResponse.status} ${await authResponse.text()}`);
    }

    const { access_token: token } = await authResponse.json();

    // Підготовка чека
    const receiptPayload = {
      goods: order.lineItems.map(item => ({
        good: {
          code: item.sku || item.productId.substr(0, 10),
          name: item.name,
          price: Math.round(item.price * 100),
        },
        quantity: Math.round(item.quantity * 1000)
      })),
      payments: [{ 
          type: "CASHLESS", 
          value: Math.round(totalAmount * 100), 
          label: "Оплата на сайті" 
      }],
      delivery: { email: order.buyerInfo.email }
    };

    // 2. Створення чека
    let createResponse = await createReceipt(token, license, receiptPayload);

    // Якщо зміна закрита -> Відкриваємо і пробуємо знову
    if (createResponse.status === 400) {
      const errorData = await createResponse.clone().json().catch(() => ({}));
      if (errorData.code === 'shift.not_opened') {
        console.log('⚠️ Зміна закрита. Відкриваємо...');
        await openShift(token, license);
        console.log('✅ Зміна відкрита. Повторюємо друк...');
        createResponse = await createReceipt(token, license, receiptPayload);
      }
    }

    if (!createResponse.ok) {
      throw new Error(`Помилка фіскалізації: ${createResponse.status} ${await createResponse.text()}`);
    }

    const receiptData = await createResponse.json();
    console.log(`🎉 Чек створено! ID: ${receiptData.id}`);

    // --- ЛОГІКА "НІЧНОГО РЕЖИМУ" ---
    // Отримуємо поточну годину в UTC
    const currentHourUTC = new Date().getUTCHours();
    
    // 20:00 UTC = 22:00 (Зима) / 23:00 (Літо) Київ
    // Якщо час більше 20:00 UTC, значить Cron вже, ймовірно, спрацював (або скоро спрацює).
    // Щоб не залишати зміну відкритою на ніч, ми закриваємо її примусово.
    
    if (currentHourUTC >= 20) {
        console.log(`🌙 Пізнє замовлення (після 22:00/23:00). Примусово закриваємо зміну...`);
        try {
            await closeShift(token, license);
            console.log('✅ Нічна зміна закрита (Z-звіт).');
        } catch (e) {
            console.error('⚠️ Не вдалося закрити нічну зміну:', e.message);
        }
    }
    // -------------------------------

    return res.status(200).json({ success: true, receiptId: receiptData.id });

  } catch (error) {
    console.error('❌ КРИТИЧНА ПОМИЛКА:', error.message);
    return res.status(500).json({ error: error.message });
  }
}

// --- Функції ---
async function createReceipt(token, license, payload) {
  return fetch(`${CHECKBOX_API}/receipts/sell`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'X-License-Key': license,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    });
}

async function openShift(token, license) {
    const r = await fetch(`${CHECKBOX_API}/shifts`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}`, 'X-License-Key': license }
    });
    if (!r.ok) throw new Error(await r.text());
}

async function closeShift(token, license) {
    const r = await fetch(`${CHECKBOX_API}/shifts/z_reports`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}`, 'X-License-Key': license }
    });
    if (!r.ok) throw new Error(await r.text());
}

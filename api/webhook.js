const CHECKBOX_API = process.env.CHECKBOX_API_URL || 'https://api.checkbox.ua/api/v1';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).send('Method Not Allowed');

  const { order } = req.body;
  if (!order) {
    return res.status(400).json({ error: 'Відсутні дані замовлення' });
  }

  const pin = process.env.CHECKBOX_CASHIER_PIN;
  const license = process.env.CHECKBOX_LICENSE_KEY;

  if (!pin || !license) {
    console.error("❌ ПОМИЛКА: Не налаштовані змінні середовища CHECKBOX у Vercel");
    return res.status(500).json({ error: "Checkbox Env Vars Missing" });
  }

  const totalAmount = order.totals.total;
  console.log(`🚀 [Vercel] Обробка замовлення #${order.number}. Сума: ${totalAmount}`);

  try {
    // --- ЕТАП 1: Авторизація касира (Login) ---
    const authResponse = await fetch(`${CHECKBOX_API}/cashier/signinPinCode`, {
      method: 'POST',
      headers: { 
        'Content-Type': 'application/json', 
        'X-License-Key': license 
      },
      body: JSON.stringify({ pin_code: pin })
    });

    if (!authResponse.ok) {
      throw new Error(`Помилка авторизації: ${authResponse.status} ${await authResponse.text()}`);
    }

    const { access_token: token } = await authResponse.json();
    console.log('✅ Авторизація успішна');

    // Підготовка товарів для чека
    const receiptPayload = {
      goods: order.lineItems.map(item => ({
        good: {
          code: item.sku || "CODE",
          name: item.name,
          price: Math.round(item.price * 100),
        },
        quantity: Math.round(item.quantity * 1000)
      })),
      payments: [{ 
          type: order.paymentType || "CASHLESS", 
          value: Math.round(totalAmount * 100), 
          label: order.paymentLabel || "Безготівкова оплата" 
      }],
      delivery: { email: order.buyerInfo.email }
    };

    // --- ЕТАП 2: Створення чека ---
    let createResponse = await createReceipt(token, license, receiptPayload);

    // Якщо зміна закрита -> Відкриваємо зміну і пробуємо знову
    if (createResponse.status === 400) {
      const errorData = await createResponse.clone().json().catch(() => ({}));
      if (errorData.code === 'shift.not_opened') {
        console.log('⚠️ Зміна закрита. Спроба відкрити нову зміну...');
        
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

        console.log('✅ Зміна успішно відкрита! Повторюємо друк чека...');
        createResponse = await createReceipt(token, license, receiptPayload);
      }
    }

    if (!createResponse.ok) {
      throw new Error(`Помилка фіскалізації: ${createResponse.status} ${await createResponse.text()}`);
    }

    const receiptData = await createResponse.json();
    console.log(`🎉 Чек успішно створено! ID: ${receiptData.id}`);

    // --- ЕТАП 3: Логіка "Нічного режиму" (Автозакриття після 22:00 за Києвом) ---
    const currentHourUTC = new Date().getUTCHours();
    if (currentHourUTC >= 20) {
        console.log(`🌙 Пізнє замовлення (після 22:00/23:00). Примусово закриваємо зміну...`);
        try {
            await closeShift(token, license);
            console.log('✅ Нічна зміна закрита (Z-звіт).');
        } catch (e) {
            console.error('⚠️ Не вдалося закрити нічну зміну:', e.message);
        }
    }

    return res.status(200).json({ success: true, receiptId: receiptData.id });

  } catch (error) {
    console.error('❌ КРИТИЧНА ПОМИЛКА:', error.message);
    return res.status(500).json({ error: error.message });
  }
}

// Допоміжні функції
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

async function closeShift(token, license) {
    const r = await fetch(`${CHECKBOX_API}/shifts/close`, {
        method: 'POST',
        headers: { 
            'Authorization': `Bearer ${token}`, 
            'X-License-Key': license 
        }
    });
    
    if (!r.ok) {
        const errorText = await r.text();
        if (errorText.includes('shift.not_opened')) {
            return; // Вже закрита
        }
        throw new Error(errorText);
    }
}

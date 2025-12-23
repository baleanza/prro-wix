const CHECKBOX_API = process.env.CHECKBOX_API_URL || 'https://api.checkbox.in.ua/api/v1';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).send('Method Not Allowed');

  const { order } = req.body;

  if (!order) {
    console.error('❌ Ошибка: Не передан объект order');
    return res.status(400).json({ error: 'Missing order data in request body' });
  }

  // --- ДЕБАГ: Перевірка змінних (не виводимо самі ключі, тільки їх наявність) ---
  const pin = process.env.CHECKBOX_CASHIER_PIN;
  const license = process.env.CHECKBOX_LICENSE_KEY;
  
  console.log(`🔍 DEBUG Checkbox Config:`);
  console.log(`- PIN встановлено? ${pin ? 'ТАК' : 'НІ'} (Довжина: ${pin ? pin.length : 0})`);
  console.log(`- LicenseKey встановлено? ${license ? 'ТАК' : 'НІ'} (Довжина: ${license ? license.length : 0})`);
  
  if (!pin || !license) {
    console.error("❌ Змінні середовища CHECKBOX_CASHIER_PIN або CHECKBOX_LICENSE_KEY не налаштовані у Vercel!");
    return res.status(500).json({ error: "Environment variables missing on Vercel" });
  }
  // -------------------------------------------------------------------------------

  const totalAmount = order.totals.total; 
  console.log(`🚀 Фіскалізація замовлення ${order.number}. Сума: ${totalAmount}`);

  try {
    // --- ШАГ 1: Логинимся в Checkbox ---
    // ВАЖЛИВО: Використовуємо 'pin_code', а не 'pin'
    const authPayload = { pin_code: pin };
    
    const authResponse = await fetch(`${CHECKBOX_API}/cashier/signin`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-License-Key': license 
      },
      body: JSON.stringify(authPayload)
    });

    if (!authResponse.ok) {
      const errText = await authResponse.text();
      // Логуємо тіло помилки, щоб бачити деталі
      console.error(`❌ Checkbox Auth Fail: ${authResponse.status}`, errText);
      throw new Error(`Помилка авторизації Checkbox: ${authResponse.status} ${errText}`);
    }

    const authData = await authResponse.json();
    const token = authData.access_token;
    console.log('✅ Авторизація в Checkbox успішна');

    // --- ШАГ 2: Формируем чек ---
    const goods = order.lineItems.map(item => {
      // Ціна приходить числом, множимо на 100 для копійок
      const price = Math.round(item.price * 100); 
      return {
        good: {
          code: item.sku || item.productId.substr(0, 10), 
          name: item.name,
          price: price, 
        },
        quantity: Math.round(item.quantity * 1000) 
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
    console.log(`🎉 Чек успішно створено! ID: ${receiptData.id}`);

    return res.status(200).json({ 
      success: true, 
      receiptId: receiptData.id 
    });

  } catch (error) {
    console.error('❌ CRITICAL ERROR:', error.message);
    return res.status(500).json({ error: error.message });
  }
}

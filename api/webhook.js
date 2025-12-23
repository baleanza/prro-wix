const CHECKBOX_API = process.env.CHECKBOX_API_URL || 'https://api.checkbox.ua/api/v1';

// Функція для паузи (чекаємо, поки ДПС зареєструє зміну)
const delay = ms => new Promise(res => setTimeout(res, ms));

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).send('Method Not Allowed');

  const { order } = req.body;
  if (!order) return res.status(400).json({ error: 'Відсутні дані замовлення' });

  const pin = process.env.CHECKBOX_CASHIER_PIN;
  const license = process.env.CHECKBOX_LICENSE_KEY;

  if (!pin || !license) {
    console.error("❌ ПОМИЛКА: Не налаштовані змінні середовища у Vercel");
    return res.status(500).json({ error: "Checkbox Env Vars Missing" });
  }

  try {
    // 1. Авторизація касира
    const authRes = await fetch(`${CHECKBOX_API}/cashier/signinPinCode`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-License-Key': license },
      body: JSON.stringify({ pin_code: pin })
    });

    if (!authRes.ok) {
      throw new Error(`Помилка авторизації: ${authRes.status} ${await authRes.text()}`);
    }

    const { access_token: token } = await authRes.json();
    console.log('✅ Авторизація успішна');

    // 2. Підготовка даних чека
    const totalAmount = order.lineItems.reduce((sum, item) => sum + (item.price * item.quantity), 0);
    
    const receiptPayload = {
      goods: order.lineItems.map(item => ({
        good: {
          code: item.sku || "000",
          name: item.name,
          price: Math.round(item.price * 100), // ціна в копійках
        },
        quantity: Math.round(item.quantity * 1000) // кількість в тисячних (грами/мл)
      })),
      payments: [{ 
          type: order.paymentType || "CASHLESS", 
          value: Math.round(totalAmount * 100), 
          label: order.paymentLabel || "Безготівкова оплата" 
      }],
      delivery: { 
          email: order.email,
          phone: order.phone // Вже відформатований у Wix (380...)
      }
    };

    // 3. Визначення ендпоінту (Продаж або Повернення)
    const endpoint = order.type === 'RETURN' ? '/receipts/return' : '/receipts/sell';
    
    let response = await fetch(`${CHECKBOX_API}${endpoint}`, {
      method: 'POST',
      headers: { 
        'Authorization': `Bearer ${token}`, 
        'X-License-Key': license, 
        'Content-Type': 'application/json' 
      },
      body: JSON.stringify(receiptPayload)
    });

    // 4. Обробка закритої зміни або зміни, що ще відкривається
    if (response.status === 400) {
        const errData = await response.clone().json().catch(() => ({}));
        
        if (errData.code === 'shift.not_opened') {
            console.log("⚠️ Зміна закрита. Спроба відкрити та зачекати реєстрації...");
            
            // Відправляємо запит на відкриття зміни
            const openShiftRes = await fetch(`${CHECKBOX_API}/shifts`, {
                method: 'POST',
                headers: { 'Authorization': `Bearer ${token}`, 'X-License-Key': license }
            });

            if (!openShiftRes.ok) {
              const openErr = await openShiftRes.text();
              // Якщо зміна вже в процесі відкриття, просто ігноруємо помилку і йдемо до delay
              if (!openErr.includes('already_opened') && !openErr.includes('opening')) {
                throw new Error(`Не вдалося відкрити зміну: ${openErr}`);
              }
            }

            // ЧЕКАЄМО 5 СЕКУНД (важливо для реальної каси)
            console.log("⏳ Пауза 5 секунд для фіскалізації зміни в ДПС...");
            await delay(5000);

            // Повторна спроба створити чек
            response = await fetch(`${CHECKBOX_API}${endpoint}`, {
                method: 'POST',
                headers: { 
                  'Authorization': `Bearer ${token}`, 
                  'X-License-Key': license, 
                  'Content-Type': 'application/json' 
                },
                body: JSON.stringify(receiptPayload)
            });
        }
    }

    // Перевірка фінального результату
    if (!response.ok) {
      throw new Error(`Помилка Checkbox API: ${response.status} ${await response.text()}`);
    }

    const result = await response.json();
    console.log(`🎉 Чек ${order.type} #${order.number} створено! ID: ${result.id}`);

    // 5. Автозакриття зміни ввечері (після 22:00 за Києвом / 20:00 UTC)
    const currentHourUTC = new Date().getUTCHours();
    if (currentHourUTC >= 20) {
        console.log('🌙 Вечірній час. Автоматичне закриття зміни...');
        await fetch(`${CHECKBOX_API}/shifts/close`, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${token}`, 'X-License-Key': license }
        }).catch(err => console.error('⚠️ Помилка автозакриття:', err.message));
    }

    return res.status(200).json({ success: true, receiptId: result.id });

  } catch (error) {
    console.error('❌ КРИТИЧНА ПОМИЛКА:', error.message);
    return res.status(500).json({ error: error.message });
  }
}

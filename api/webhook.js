const CHECKBOX_API = process.env.CHECKBOX_API_URL || 'https://api.checkbox.ua/api/v1';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).send('Method Not Allowed');

  const { order } = req.body;
  if (!order) return res.status(400).json({ error: 'Відсутні дані замовлення' });

  const pin = process.env.CHECKBOX_CASHIER_PIN;
  const license = process.env.CHECKBOX_LICENSE_KEY;

  try {
    // 1. Авторизація
    const authResponse = await fetch(`${CHECKBOX_API}/cashier/signinPinCode`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-License-Key': license },
      body: JSON.stringify({ pin_code: pin })
    });
    
    if (!authResponse.ok) throw new Error("Auth failed");
    const { access_token: token } = await authResponse.json();

    // 2. Розрахунок загальної суми для платежу
    const totalAmount = order.lineItems.reduce((sum, item) => sum + (item.price * item.quantity), 0);

    // 3. Формування Payload
    const receiptPayload = {
      goods: order.lineItems.map(item => ({
        good: {
          code: item.sku || "000",
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
      delivery: { 
          email: order.email,
          phone: order.phone 
      }
    };

    // 4. Визначення типу операції (Продаж або Повернення)
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

    // 5. Якщо зміна закрита — відкриваємо
    if (response.status === 400) {
        const errorData = await response.clone().json();
        if (errorData.code === 'shift.not_opened') {
            await fetch(`${CHECKBOX_API}/shifts`, {
                method: 'POST',
                headers: { 'Authorization': `Bearer ${token}`, 'X-License-Key': license }
            });
            // Повторний запит
            response = await fetch(`${CHECKBOX_API}${endpoint}`, {
                method: 'POST',
                headers: { 'Authorization': `Bearer ${token}`, 'X-License-Key': license, 'Content-Type': 'application/json' },
                body: JSON.stringify(receiptPayload)
            });
        }
    }

    if (!response.ok) throw new Error(await response.text());

    const result = await response.json();
    console.log(`✅ Чек ${order.type} #${order.number} успішно створено. ID: ${result.id}`);

    // Нічне автозакриття (якщо замовлення прийшло пізно)
    const currentHour = new Date().getUTCHours();
    if (currentHour >= 20) {
        await fetch(`${CHECKBOX_API}/shifts/close`, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${token}`, 'X-License-Key': license }
        });
    }

    return res.status(200).json({ success: true, receiptId: result.id });

  } catch (error) {
    console.error('❌ Помилка фіскалізації:', error.message);
    return res.status(500).json({ error: error.message });
  }
}

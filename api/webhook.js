const CHECKBOX_API = process.env.CHECKBOX_API_URL || 'https://api.checkbox.ua/api/v1';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).send('Method Not Allowed');
  const { order } = req.body;
  if (!order) return res.status(400).json({ error: 'No data' });

  const pin = process.env.CHECKBOX_CASHIER_PIN;
  const license = process.env.CHECKBOX_LICENSE_KEY;

  try {
    // 1. Авторизація
    const authRes = await fetch(`${CHECKBOX_API}/cashier/signinPinCode`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-License-Key': license },
      body: JSON.stringify({ pin_code: pin })
    });
    if (!authRes.ok) throw new Error("Auth failed");
    const { access_token: token } = await authRes.json();

    // 2. Підготовка даних
    const totalAmount = order.lineItems.reduce((s, i) => s + (i.price * i.quantity), 0);
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
          phone: order.phone // Вже відформатований у Wix
      }
    };

    // 3. Вибір методу (Продаж/Повернення)
    const endpoint = order.type === 'RETURN' ? '/receipts/return' : '/receipts/sell';
    let response = await fetch(`${CHECKBOX_API}${endpoint}`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}`, 'X-License-Key': license, 'Content-Type': 'application/json' },
      body: JSON.stringify(receiptPayload)
    });

    // 4. Обробка закритої зміни
    if (response.status === 400) {
        const errData = await response.clone().json();
        if (errData.code === 'shift.not_opened') {
            await fetch(`${CHECKBOX_API}/shifts`, {
                method: 'POST',
                headers: { 'Authorization': `Bearer ${token}`, 'X-License-Key': license }
            });
            response = await fetch(`${CHECKBOX_API}${endpoint}`, {
                method: 'POST',
                headers: { 'Authorization': `Bearer ${token}`, 'X-License-Key': license, 'Content-Type': 'application/json' },
                body: JSON.stringify(receiptPayload)
            });
        }
    }

    if (!response.ok) throw new Error(await response.text());
    const result = await response.json();
    console.log(`✅ Чек ${order.type} #${order.number} створено: ${result.id}`);

    // 5. Автозакриття вночі (22:00+ за Києвом)
    if (new Date().getUTCHours() >= 20) {
        await fetch(`${CHECKBOX_API}/shifts/close`, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${token}`, 'X-License-Key': license }
        });
    }

    return res.status(200).json({ success: true, id: result.id });
  } catch (error) {
    console.error('❌ Помилка:', error.message);
    return res.status(500).json({ error: error.message });
  }
}

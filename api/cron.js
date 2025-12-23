const DEFAULT_API = 'https://api.checkbox.ua/api/v1';

module.exports = async function handler(req, res) {
  let baseUrl = process.env.CHECKBOX_API_URL || DEFAULT_API;
  if (baseUrl.endsWith('/')) {
      baseUrl = baseUrl.slice(0, -1);
  }

  const pin = process.env.CHECKBOX_CASHIER_PIN;
  const license = process.env.CHECKBOX_LICENSE_KEY;

  if (!pin || !license) {
    return res.status(500).json({ error: "Checkbox Env Vars Missing" });
  }

  console.log(`⏰ [CRON] Старт автоматичного закриття. API: ${baseUrl}`);

  try {
    // 1. Авторизація
    const authResponse = await fetch(`${baseUrl}/cashier/signinPinCode`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-License-Key': license },
      body: JSON.stringify({ pin_code: pin })
    });

    if (!authResponse.ok) {
      throw new Error(`Помилка авторизації: ${authResponse.status}`);
    }

    const { access_token: token } = await authResponse.json();

    // 2. Перевірка статусу зміни
    const shiftResponse = await fetch(`${baseUrl}/cashier/shift`, {
        method: 'GET',
        headers: { 
            'Authorization': `Bearer ${token}`,
            'X-License-Key': license 
        }
    });

    if (shiftResponse.ok) {
        const shiftData = await shiftResponse.json();
        if (!shiftData || shiftData.status === 'CLOSED') {
            console.log('ℹ️ Активної зміни немає. Закриття не потрібне.');
            return res.status(200).json({ message: "No active shift" });
        }
        console.log(`ℹ️ Зміна ${shiftData.id} відкрита. Закриваємо...`);
    }

    // 3. Закриття зміни
    const closeResponse = await fetch(`${baseUrl}/shifts/close`, {
        method: 'POST',
        headers: { 
            'Authorization': `Bearer ${token}`,
            'X-License-Key': license,
            'Content-Type': 'application/json'
        }
    });

    if (closeResponse.ok) {
        console.log('✅ Зміна успішно закрита (Z-звіт сформовано).');
        return res.status(200).json({ success: true });
    } 
    
    const errorText = await closeResponse.text();
    if (errorText.includes('shift.not_opened')) {
        return res.status(200).json({ message: "Already closed" });
    }

    throw new Error(`Помилка закриття: ${errorText}`);

  } catch (error) {
    console.error('❌ CRON ERROR:', error.message);
    return res.status(500).json({ error: error.message });
  }
};

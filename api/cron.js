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

  console.log(`⏰ [CRON] Старт. API URL: ${baseUrl}`);

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
    console.log('✅ Авторизація успішна. Перевіряємо статус зміни...');

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
            console.log('ℹ️ Активної зміни немає або вона вже закрита.');
            return res.status(200).json({ message: "No active shift" });
        }
        
        console.log(`ℹ️ Зміна відкрита (ID: ${shiftData.id}). Закриваємо...`);
    }

    // --- КРОК 3: ЗАКРИТТЯ ЗМІНИ ---
    // ВИПРАВЛЕНО: Правильний шлях для закриття - /shifts/close
    const closeShiftUrl = `${baseUrl}/shifts/close`;
    console.log(`📡 Відправляємо запит на закриття: ${closeShiftUrl}`);

    const closeResponse = await fetch(closeShiftUrl, {
        method: 'POST',
        headers: { 
            'Authorization': `Bearer ${token}`,
            'X-License-Key': license,
            'Content-Type': 'application/json'
        }
    });

    if (closeResponse.ok) {
        console.log('✅ Зміна успішно закрита (Z-звіт сформовано автоматично).');
        return res.status(200).json({ success: true, message: "Shift closed" });
    } 
    
    const errorText = await closeResponse.text();
    console.log(`ℹ️ Результат закриття: ${closeResponse.status} ${errorText}`);
    
    if (errorText.includes('shift.not_opened')) {
        return res.status(200).json({ success: true, message: "Shift was already closed" });
    }

    throw new Error(`Помилка закриття зміни: ${errorText}`);

  } catch (error) {
    console.error('❌ CRON ERROR:', error.message);
    return res.status(500).json({ error: error.message });
  }
};

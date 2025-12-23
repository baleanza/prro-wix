// Використовуємо modern домен за замовчуванням
const DEFAULT_API = 'https://api.checkbox.ua/api/v1';

module.exports = async function handler(req, res) {
  // 1. Очищення URL від зайвих слешів в кінці
  let baseUrl = process.env.CHECKBOX_API_URL || DEFAULT_API;
  if (baseUrl.endsWith('/')) {
      baseUrl = baseUrl.slice(0, -1);
  }

  const authHeader = req.headers['authorization'];
  if (process.env.CRON_SECRET && authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
      // console.log('⚠️ Запуск не від планувальника Vercel');
  }

  const pin = process.env.CHECKBOX_CASHIER_PIN;
  const license = process.env.CHECKBOX_LICENSE_KEY;

  if (!pin || !license) {
    return res.status(500).json({ error: "Checkbox Env Vars Missing" });
  }

  console.log(`⏰ [CRON] Старт. API URL: ${baseUrl}`);

  try {
    // --- КРОК 1: Перевіряємо статус касира (чи відкрита зміна взагалі?) ---
    // Це допоможе уникнути помилок, якщо зміна вже закрита
    
    // Спочатку логінимось
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

    // Отримуємо поточну зміну
    const shiftResponse = await fetch(`${baseUrl}/cashier/shift`, {
        method: 'GET',
        headers: { 
            'Authorization': `Bearer ${token}`,
            'X-License-Key': license 
        }
    });

    if (shiftResponse.ok) {
        const shiftData = await shiftResponse.json();
        
        if (!shiftData) {
            console.log('ℹ️ Активної зміни немає (зміна вже закрита).');
            return res.status(200).json({ message: "No active shift" });
        }
        
        if (shiftData.status === 'CLOSED') {
             console.log('ℹ️ Поточна зміна вже має статус CLOSED.');
             return res.status(200).json({ message: "Shift already closed" });
        }
        
        console.log(`ℹ️ Зміна відкрита (ID: ${shiftData.id}). Закриваємо...`);
    }

    // --- КРОК 2: Робимо Z-звіт (Закриття) ---
    const zReportUrl = `${baseUrl}/shifts/z_reports`;
    console.log(`📡 Відправляємо запит на: ${zReportUrl}`);

    const zReportResponse = await fetch(zReportUrl, {
        method: 'POST',
        headers: { 
            'Authorization': `Bearer ${token}`,
            'X-License-Key': license,
            'Content-Type': 'application/json'
        }
    });

    if (zReportResponse.ok) {
        console.log('✅ Зміна успішно закрита (Z-звіт створено).');
        return res.status(200).json({ success: true, message: "Shift closed" });
    } 
    
    const errorText = await zReportResponse.text();
    console.log(`ℹ️ Результат закриття: ${zReportResponse.status} ${errorText}`);
    
    if (errorText.includes('shift.not_opened') || errorText.includes('Зміну не відкрито')) {
        return res.status(200).json({ success: true, message: "Shift was already closed" });
    }

    throw new Error(`Помилка Z-звіту: ${errorText}`);

  } catch (error) {
    console.error('❌ CRON ERROR:', error.message);
    return res.status(500).json({ error: error.message });
  }
};

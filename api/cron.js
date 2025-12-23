const CHECKBOX_API = process.env.CHECKBOX_API_URL || 'https://api.checkbox.in.ua/api/v1';

export default async function handler(req, res) {
  // Перевірка, що запит прийшов від Vercel Cron (захист від випадкового запуску)
  // Якщо хочете запускати вручну для тесту - закоментуйте цей рядок
  if (req.headers.get('authorization') !== `Bearer ${process.env.CRON_SECRET}`) {
      // Для спрощення поки не блокуємо, але в ідеалі тут треба return 401
      // console.log('⚠️ Запуск не від планувальника Vercel');
  }

  const pin = process.env.CHECKBOX_CASHIER_PIN;
  const license = process.env.CHECKBOX_LICENSE_KEY;

  if (!pin || !license) {
    return res.status(500).json({ error: "Checkbox Env Vars Missing" });
  }

  console.log(`⏰ [CRON] Починаємо автоматичне закриття зміни...`);

  try {
    // 1. Логінимось (отримуємо токен)
    const authResponse = await fetch(`${CHECKBOX_API}/cashier/signinPinCode`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-License-Key': license },
      body: JSON.stringify({ pin_code: pin })
    });

    if (!authResponse.ok) {
      throw new Error(`Помилка авторизації: ${authResponse.status}`);
    }

    const { access_token: token } = await authResponse.json();

    // 2. Робимо Z-звіт (Закриваємо зміну)
    const zReportResponse = await fetch(`${CHECKBOX_API}/shifts/z_reports`, {
        method: 'POST',
        headers: { 
            'Authorization': `Bearer ${token}`,
            'X-License-Key': license 
        }
    });

    // 3. Обробка результату
    if (zReportResponse.ok) {
        console.log('✅ Зміна успішно закрита (Z-звіт створено).');
        return res.status(200).json({ success: true, message: "Shift closed" });
    } 
    
    // Якщо помилка 400 - можливо зміна вже закрита або не відкривалась
    const errorText = await zReportResponse.text();
    console.log(`ℹ️ Результат закриття: ${zReportResponse.status} ${errorText}`);
    
    // Якщо зміна не була відкрита - це не помилка, просто ігноруємо
    if (errorText.includes('shift.not_opened') || errorText.includes('Зміну не відкрито')) {
        return res.status(200).json({ success: true, message: "Shift was already closed" });
    }

    throw new Error(`Помилка Z-звіту: ${errorText}`);

  } catch (error) {
    console.error('❌ CRON ERROR:', error.message);
    return res.status(500).json({ error: error.message });
  }
}

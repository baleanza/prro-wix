const CHECKBOX_API = process.env.CHECKBOX_API_URL || 'https://api.checkbox.in.ua/api/v1';

export default async function handler(req, res) {
  // ВИПРАВЛЕННЯ: У Node.js headers - це об'єкт, а не Map
  const authHeader = req.headers['authorization'];

  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
      // Якщо це не Cron, можна просто залогувати, або повернути 401
      // console.log('⚠️ Запуск не від планувальника Vercel');
  }

  const pin = process.env.CHECKBOX_CASHIER_PIN;
  const license = process.env.CHECKBOX_LICENSE_KEY;

  if (!pin || !license) {
    return res.status(500).json({ error: "Checkbox Env Vars Missing" });
  }

  console.log(`⏰ [CRON] Починаємо автоматичне закриття зміни...`);

  try {
    // 1. Логінимось
    const authResponse = await fetch(`${CHECKBOX_API}/cashier/signinPinCode`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-License-Key': license },
      body: JSON.stringify({ pin_code: pin })
    });

    if (!authResponse.ok) {
      throw new Error(`Помилка авторизації: ${authResponse.status}`);
    }

    const { access_token: token } = await authResponse.json();

    // 2. Робимо Z-звіт
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
    
    const errorText = await zReportResponse.text();
    console.log(`ℹ️ Результат закриття: ${zReportResponse.status} ${errorText}`);
    
    // Якщо зміна не була відкрита - це ОК
    if (errorText.includes('shift.not

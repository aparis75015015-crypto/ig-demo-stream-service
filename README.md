# IG Demo Stream Service

خدمة قراءة فقط تربط IG Demo بلوحة Retool دون تشغيل n8n كل عدة ثوانٍ. لا تحتوي أي مسار لإنشاء أو تعديل أو إغلاق الصفقات.

## الوظائف

- `GET /health` حالة الخدمة.
- `GET /snapshot` آخر سعر محفوظ.
- `GET /events` بث SSE للسعر كل 5 ثوانٍ افتراضيًا.
- IG Demo فقط؛ العنوان الافتراضي مثبت على `demo-api.ig.com`.

## التشغيل

1. انسخ `.env.example` إلى إعدادات الأسرار في منصة الاستضافة.
2. أدخل `IG_API_KEY` و`IG_IDENTIFIER` و`IG_PASSWORD` كأسرار، ولا تضعها في الكود.
3. شغّل `npm install` ثم `npm start`.
4. اربط Retool بـ`/events` للسعر الحي، و`/snapshot` للتحميل الأولي.

## الأمان

- لا توجد endpoints للتداول.
- لا تعاد رموز OAuth أو بيانات الدخول للعميل.
- CORS مقيد افتراضيًا بـ`https://goldagent.retool.com`.
- احتفظ بتنفيذ IG Demo في n8n خلف Safety Gate منفصل.

## دمج Retool

```ts
const stream = new EventSource(`${PRICE_SERVICE_URL}/events`)
stream.onmessage = (event) => {
  const quote = JSON.parse(event.data)
  if (quote.ok) setLivePrice(quote)
}
```

المتغير `PRICE_SERVICE_URL` يجب أن يكون عنوان الخدمة المنشورة، وليس عنوان IG ولا مفتاحًا سريًا.

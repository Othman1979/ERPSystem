export const ar = {
  app: {
    title: 'ERP Cloud',
    tagline: 'نظام المحاسبة والمستودعات',
  },
  nav: {
    health: 'حالة النظام',
  },
  language: {
    switchTo: 'English',
  },
  health: {
    title: 'فحص الاتصال',
    apiOk: 'الواجهة متصلة بالخادم',
    dbOk: 'قاعدة البيانات تعمل',
    dbDown: 'قاعدة البيانات غير متاحة',
    loading: 'جارٍ الفحص…',
    error: 'تعذر الوصول إلى الخادم',
    lastChecked: 'آخر فحص',
  },
  errors: {
    INTERNAL: 'خطأ داخلي في الخادم',
    VALIDATION: 'بيانات غير صالحة',
    UNAUTHORIZED: 'غير مصرح',
    FORBIDDEN: 'ممنوع',
    NOT_FOUND: 'غير موجود',
    CONFLICT: 'تعارض',
    STOCK_INSUFFICIENT: 'الرصيد غير كافٍ',
    BACKDATED_STOCK_POSTING: 'لا يمكن الترحيل بتاريخ سابق',
    PERIOD_CLOSED: 'الفترة المالية مغلقة',
    UNBALANCED_ENTRY: 'قيد غير متوازن',
    PLAN_LIMIT_EXCEEDED: 'تم تجاوز حدود الباقة',
    IDEMPOTENCY_KEY_REUSED: 'مفتاح الطلب مستخدم بمحتوى مختلف',
  },
};

export const en: typeof ar = {
  app: {
    title: 'ERP Cloud',
    tagline: 'Accounting & Inventory System',
  },
  nav: {
    health: 'System Health',
  },
  language: {
    switchTo: 'العربية',
  },
  health: {
    title: 'Connection Check',
    apiOk: 'Frontend reached the server',
    dbOk: 'Database is reachable',
    dbDown: 'Database is unavailable',
    loading: 'Checking…',
    error: 'Cannot reach the server',
    lastChecked: 'Last checked',
  },
  errors: {
    INTERNAL: 'Internal server error',
    VALIDATION: 'Invalid input',
    UNAUTHORIZED: 'Unauthorized',
    FORBIDDEN: 'Forbidden',
    NOT_FOUND: 'Not found',
    CONFLICT: 'Conflict',
    STOCK_INSUFFICIENT: 'Insufficient stock',
    BACKDATED_STOCK_POSTING: 'Cannot post with a past date',
    PERIOD_CLOSED: 'Fiscal period is closed',
    UNBALANCED_ENTRY: 'Unbalanced journal entry',
    PLAN_LIMIT_EXCEEDED: 'Plan limit exceeded',
    IDEMPOTENCY_KEY_REUSED: 'Idempotency key reused with different content',
  },
};
